import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Code,
  Modal,
  NativeSelect,
  Paper,
  Tabs,
  TextInput,
  createTheme,
} from '@mantine/core';

const sansFamily = '"Avenir Next", "Helvetica Neue", Arial, sans-serif';
const monoFamily = '"SF Mono", "SFMono-Regular", "Roboto Mono", "Menlo", monospace';

export const agentflowTheme = createTheme({
  fontFamily: sansFamily,
  fontFamilyMonospace: monoFamily,
  headings: {
    fontFamily: sansFamily,
    fontWeight: '800',
  },
  primaryColor: 'signal',
  defaultRadius: 'xs',
  colors: {
    ink: ['#f4f4f4', '#dddddd', '#c3c3c3', '#ababab', '#8d8d8d', '#6f6f6f', '#555555', '#333333', '#1f1f1f', '#111111'],
    signal: ['#fff6bf', '#ffef97', '#ffe870', '#ffe14a', '#ffdb26', '#f2ca00', '#c59e00', '#927500', '#614d00', '#302600'],
    electric: ['#eefbff', '#cff5ff', '#b0eeff', '#91e8ff', '#71dfff', '#4dcfff', '#24baf1', '#1497c6', '#0f7193', '#0a4a61'],
    danger: ['#fff1ef', '#ffd8d3', '#ffbeb8', '#ffa39b', '#ff847a', '#ff695d', '#f3463f', '#ca2f29', '#9b221f', '#6a1715'],
  },
  radius: {
    xs: '0px',
    sm: '2px',
    md: '4px',
    lg: '6px',
    xl: '8px',
  },
  components: {
    Paper: Paper.extend({
      defaultProps: {
        radius: 'xs',
        withBorder: true,
        shadow: undefined,
      },
    }),
    Card: Card.extend({
      defaultProps: {
        radius: 'xs',
        withBorder: true,
        shadow: undefined,
      },
    }),
    Modal: Modal.extend({
      defaultProps: {
        radius: 'sm',
        centered: true,
        overlayProps: {
          backgroundOpacity: 0.2,
          blur: 0,
        },
      },
    }),
    Button: Button.extend({
      defaultProps: {
        radius: 'xs',
      },
    }),
    ActionIcon: ActionIcon.extend({
      defaultProps: {
        radius: 'xs',
      },
    }),
    Badge: Badge.extend({
      defaultProps: {
        radius: 'xs',
      },
    }),
    Tabs: Tabs.extend({
      defaultProps: {
        radius: 'xs',
        variant: 'outline',
      },
    }),
    TextInput: TextInput.extend({
      defaultProps: {
        radius: 'xs',
      },
    }),
    NativeSelect: NativeSelect.extend({
      defaultProps: {
        radius: 'xs',
      },
    }),
    Code: Code.extend({
      defaultProps: {
        block: false,
      },
    }),
  },
});
