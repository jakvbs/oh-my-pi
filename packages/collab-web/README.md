# @oh-my-pi/collab-web

Per-tool React renderers embedded in coding-agent HTML session exports. This fork removed the collab web client and relay; only `src/tool-render/` remains.

- `src/tool-render/`: one view per built-in tool, common `ToolView` chrome, theme-adaptive `tv-` design tokens, and an `<omp-tool-view>` web-component wrapper.
- `scripts/build-tool-views.ts`: bundles `src/tool-render/` and React into `packages/coding-agent/src/export/html/tool-views.generated.js` (`bun run gen:tool-views`).
