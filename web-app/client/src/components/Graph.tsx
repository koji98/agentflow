import React, { useEffect, useMemo, useState } from 'react';
import dagre from 'dagre';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  Position,
  Handle,
  MarkerType,
  type ReactFlowInstance,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { Badge, Box, Group, Stack, Text } from '@mantine/core';

import type { RunStateResponse } from '../../../shared/contracts/monitor.ts';
import {
  buildFocusedWorkflowGraph,
  buildWorkflowGraph,
  type GraphFocusMode,
  type WorkflowGraph,
} from '../lib/monitor.ts';
import { EmptyState, SurfaceLabel } from '../design/primitives.tsx';

const STATUS_COLORS: Record<string, string> = {
  RUNNING: '#4dcfff',
  DONE: '#ffe14a',
  FAILED: '#ff8c84',
  PENDING: '#64748b',
};

const NODE_WIDTH = 278;
const NODE_HEIGHT = 122;
const NARROW_GRAPH_VIEWPORT_WIDTH = 900;

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function readableToken(value: string | null | undefined): string {
  return String(value || '')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .trim();
}

export function shouldFitSelectedGraph(options: {
  hiddenCount: number;
  viewportWidth: number | null;
}) {
  const { hiddenCount, viewportWidth } = options;
  return hiddenCount > 0 || (viewportWidth !== null && viewportWidth < NARROW_GRAPH_VIEWPORT_WIDTH);
}

export function graphFitPadding(options: {
  hiddenCount: number;
  viewportWidth: number | null;
}) {
  const { hiddenCount, viewportWidth } = options;
  if (viewportWidth !== null && viewportWidth < NARROW_GRAPH_VIEWPORT_WIDTH) return 0.24;
  if (hiddenCount > 0) return 0.18;
  return 0.14;
}

function graphMaxZoom(viewportWidth: number | null) {
  return viewportWidth !== null && viewportWidth < NARROW_GRAPH_VIEWPORT_WIDTH ? 0.94 : 1.02;
}

function layoutElements(nodes: Node[], edges: Edge[]) {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'LR',
    align: 'UL',
    nodesep: 34,
    ranksep: 82,
    marginx: 20,
    marginy: 20,
  });

  nodes.forEach((node) => {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });
  edges.forEach((edge) => {
    graph.setEdge(edge.source, edge.target);
  });

  dagre.layout(graph);

  return nodes.map((node) => {
    const position = graph.node(node.id);
    return {
      ...node,
      position: {
        x: position.x - NODE_WIDTH / 2,
        y: position.y - NODE_HEIGHT / 2,
      },
    };
  });
}

function WorkflowNodeCard({ data, selected }: NodeProps<any>) {
  const status = String(data.status || 'PENDING');
  const phase = readableToken(data.phase);
  const metrics = Array.isArray(data.metrics) ? data.metrics as string[] : [];
  const emphasis = String(data.emphasis || 'primary');
  const isFollowed = data.isFollowed === true;
  const focusFlag = selected ? 'scope' : isFollowed ? 'evidence' : null;
  return (
    <Box
      className={`graph-node graph-node--${String(data.type)} graph-node--${emphasis} ${selected ? 'graph-node--selected' : ''} ${isFollowed ? 'graph-node--followed' : ''}`}
      data-emphasis={emphasis}
      data-followed={isFollowed ? 'true' : 'false'}
    >
      <Handle type="target" position={Position.Left} />
      <Stack gap={8}>
        <Group justify="space-between" align="flex-start" gap="xs">
          <Stack gap={2}>
            <SurfaceLabel>{String(data.type).replaceAll('_', ' ')}</SurfaceLabel>
            <Text fw={700} size="sm">
              {String(data.label)}
            </Text>
          </Stack>
          <Stack gap={6} align="flex-end">
            <Badge
              size="sm"
              variant="light"
              color={
                status === 'DONE'
                  ? 'signal'
                  : status === 'FAILED'
                    ? 'danger'
                    : status === 'RUNNING'
                      ? 'electric'
                    : 'ink'
              }
            >
              {status.toLowerCase()}
            </Badge>
            {focusFlag ? (
              <span className={`graph-node__flag ${selected ? 'graph-node__flag--scope' : ''}`}>{focusFlag}</span>
            ) : null}
          </Stack>
        </Group>
        {phase && phase !== status.toLowerCase() ? (
          <Group gap={6}>
            <Badge size="xs" variant="outline">
              {phase}
            </Badge>
          </Group>
        ) : null}
        <Text size="sm" c="dimmed" lineClamp={2}>
          {String(data.subtitle || 'No summary available.')}
        </Text>
        {metrics.length > 0 ? (
          <div className="graph-node__metrics">
            {metrics.slice(0, 2).map((metric) => (
              <span className="graph-node__metric" key={`${String(data.graphId)}:${metric}`}>
                {metric}
              </span>
            ))}
          </div>
        ) : null}
      </Stack>
      <Handle type="source" position={Position.Right} />
    </Box>
  );
}

const nodeTypes = { workflowNode: WorkflowNodeCard };

export default function Graph(props: {
  graph?: WorkflowGraph | null;
  plan: Record<string, unknown> | null;
  state: RunStateResponse | null;
  trace: Array<Record<string, unknown>>;
  onSelectNode: (id: string) => void;
  selectedId?: string;
  selectionKey?: 'workflowId' | 'graphId';
  focusMode?: GraphFocusMode;
  followId?: string;
  className?: string;
  showMiniMap?: boolean;
  showControls?: boolean;
  onPaneClick?: () => void;
}) {
  const {
    graph: graphProp,
    plan,
    state,
    trace,
    onSelectNode,
    selectedId,
    selectionKey = 'workflowId',
    focusMode = 'full',
    followId,
    className,
    showMiniMap = true,
    showControls = true,
    onPaneClick,
  } = props;
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(
    typeof window === 'undefined' ? null : window.innerWidth,
  );
  const graph = useMemo(
    () => graphProp || buildWorkflowGraph(plan, state, trace),
    [graphProp, plan, state, trace],
  );
  const focusedGraph = useMemo(
    () => buildFocusedWorkflowGraph(graph, { selectedId, selectionKey, mode: focusMode, followId }),
    [focusMode, followId, graph, selectedId, selectionKey],
  );
  const fitPadding = useMemo(
    () => graphFitPadding({ hiddenCount: focusedGraph.counts.hidden, viewportWidth }),
    [focusedGraph.counts.hidden, viewportWidth],
  );
  const fitMaxZoom = useMemo(() => graphMaxZoom(viewportWidth), [viewportWidth]);

  const nodes = useMemo<Node[]>(() => {
    const baseNodes = focusedGraph.items.map((item) => ({
      id: item.graphId,
      type: 'workflowNode',
      position: { x: 0, y: 0 },
      data: {
        ...item,
        emphasis: focusedGraph.emphasis.get(item.graphId) || 'primary',
        isFollowed: Boolean(followId && item.workflowId === followId),
      },
      selected: (selectionKey === 'graphId' ? item.graphId : item.workflowId) === selectedId,
      draggable: false,
    }));
    const laidOut = layoutElements(baseNodes, focusedGraph.edges.map((edge) => ({
      ...edge,
      source: edge.source,
      target: edge.target,
    })));
    return laidOut;
  }, [followId, focusedGraph.edges, focusedGraph.emphasis, focusedGraph.items, selectedId, selectionKey]);

  const edges = useMemo<Edge[]>(() => {
    return focusedGraph.edges.map((edge) => {
      const sourceEmphasis = focusedGraph.emphasis.get(edge.source) || 'primary';
      const targetEmphasis = focusedGraph.emphasis.get(edge.target) || 'primary';
      const muted = sourceEmphasis === 'muted' && targetEmphasis === 'muted';
      const contextual = !muted && (sourceEmphasis === 'context' || targetEmphasis === 'context');
      const stroke = muted ? '#b7c2cc' : contextual ? '#8fa0b5' : '#4b5b6b';
      return {
        ...edge,
        className: muted ? 'graph-edge graph-edge--muted' : contextual ? 'graph-edge graph-edge--context' : 'graph-edge graph-edge--primary',
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        animated: Boolean(edge.animated) && !muted,
        style: { stroke, strokeWidth: muted ? 1 : 1.6, opacity: muted ? 0.26 : contextual ? 0.7 : 1 },
        labelStyle: { fill: '#64748b', fontSize: 11 },
        type: 'smoothstep',
      };
    });
  }, [focusedGraph.edges, focusedGraph.emphasis]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    if (!flow || nodes.length === 0) return;
    if (!selectedId) {
      flow.fitView({ padding: fitPadding, duration: 220, maxZoom: fitMaxZoom });
      return;
    }
    if (shouldFitSelectedGraph({ hiddenCount: focusedGraph.counts.hidden, viewportWidth })) {
      flow.fitView({ padding: fitPadding, duration: 260, maxZoom: fitMaxZoom });
      return;
    }
    const selectedNode = nodes.find((node) => {
      const key = selectionKey === 'graphId' ? String(node.data.graphId) : String(node.data.workflowId);
      return key === selectedId;
    });
    if (!selectedNode) return;
    flow.setCenter(
      selectedNode.position.x + NODE_WIDTH / 2,
      selectedNode.position.y + NODE_HEIGHT / 2,
      { zoom: 1.02, duration: 260 },
    );
  }, [fitMaxZoom, fitPadding, flow, focusedGraph.counts.hidden, nodes, selectedId, selectionKey, viewportWidth]);

  if (nodes.length === 0) {
    return (
      <Box className={cx('graph-surface', className)}>
        <EmptyState
          className="graph-empty-overlay"
          title="No graph available"
          description="Load or start a plan to render the workflow topology."
        />
      </Box>
    );
  }

  return (
    <Box className={cx('graph-surface', className)}>
      <ReactFlow
        fitView
        fitViewOptions={{ padding: fitPadding, maxZoom: fitMaxZoom }}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={setFlow}
        onNodeClick={(_, node) => onSelectNode(String(selectionKey === 'graphId' ? node.data.graphId : node.data.workflowId))}
        onPaneClick={() => onPaneClick?.()}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        {showMiniMap ? (
          <MiniMap
            pannable
            zoomable
            nodeBorderRadius={2}
            maskColor="rgba(238, 243, 245, 0.72)"
            nodeColor={(node) => STATUS_COLORS[String(node.data.status || 'PENDING')] || STATUS_COLORS.PENDING}
          />
        ) : null}
        {showControls ? <Controls showInteractive={false} /> : null}
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d7e3ee" />
      </ReactFlow>
    </Box>
  );
}
