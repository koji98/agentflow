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
import { buildWorkflowGraph } from '../lib/monitor.ts';
import { EmptyState, SurfaceLabel } from '../design/primitives.tsx';

const STATUS_COLORS: Record<string, string> = {
  RUNNING: '#4dcfff',
  DONE: '#ffe14a',
  FAILED: '#ff8c84',
  PENDING: '#64748b',
};

const NODE_WIDTH = 278;
const NODE_HEIGHT = 122;

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
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
  return (
    <Box className={`graph-node graph-node--${String(data.type)} ${selected ? 'graph-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <Stack gap={8}>
        <Group justify="space-between" align="flex-start" gap="xs">
          <Stack gap={2}>
            <SurfaceLabel>{String(data.type).replaceAll('_', ' ')}</SurfaceLabel>
            <Text fw={700} size="sm">
              {String(data.label)}
            </Text>
          </Stack>
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
        </Group>
        <Text size="sm" c="dimmed" lineClamp={2}>
          {String(data.subtitle || 'No summary available.')}
        </Text>
      </Stack>
      <Handle type="source" position={Position.Right} />
    </Box>
  );
}

const nodeTypes = { workflowNode: WorkflowNodeCard };

export default function Graph(props: {
  plan: Record<string, unknown> | null;
  state: RunStateResponse | null;
  trace: Array<Record<string, unknown>>;
  onSelectNode: (id: string) => void;
  selectedId?: string;
  selectionKey?: 'workflowId' | 'graphId';
  className?: string;
  showMiniMap?: boolean;
  showControls?: boolean;
  onPaneClick?: () => void;
}) {
  const {
    plan,
    state,
    trace,
    onSelectNode,
    selectedId,
    selectionKey = 'workflowId',
    className,
    showMiniMap = true,
    showControls = true,
    onPaneClick,
  } = props;
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const graph = useMemo(() => buildWorkflowGraph(plan, state, trace), [plan, state, trace]);

  const nodes = useMemo<Node[]>(() => {
    const baseNodes = graph.items.map((item) => ({
      id: item.graphId,
      type: 'workflowNode',
      position: { x: 0, y: 0 },
      data: item,
      selected: (selectionKey === 'graphId' ? item.graphId : item.workflowId) === selectedId,
      draggable: false,
    }));
    const laidOut = layoutElements(baseNodes, graph.edges.map((edge) => ({
      ...edge,
      source: edge.source,
      target: edge.target,
    })));
    return laidOut;
  }, [graph.edges, graph.items, selectedId, selectionKey]);

  const edges = useMemo<Edge[]>(() => {
    return graph.edges.map((edge) => ({
      ...edge,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#8fa0b5' },
      animated: Boolean(edge.animated),
      style: { stroke: '#8fa0b5', strokeWidth: 1.35 },
      labelStyle: { fill: '#64748b', fontSize: 11 },
      type: 'smoothstep',
    }));
  }, [graph.edges]);

  useEffect(() => {
    if (!flow || nodes.length === 0) return;
    if (!selectedId) {
      flow.fitView({ padding: 0.14, duration: 220 });
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
  }, [flow, nodes, selectedId, selectionKey]);

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
        fitViewOptions={{ padding: 0.14 }}
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
