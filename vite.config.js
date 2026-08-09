import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The whole experiment hinges on measuring a *production* React. Vite's dev
// server always serves the development build, which is several times slower and
// carries warnings, extra invariants and dev-only bookkeeping. So the real runs
// happen against `vite build && vite preview`, and the UI shouts if you forget.
//
// The default build is therefore untouched production React. `react-dom/profiling`
// is available with PROFILING=1 purely as a cross-check — it is what makes
// <Profiler> report anything in a production build, and measuring it is how you
// confirm that <Profiler> is far too expensive to measure with.
const profiling = process.env.PROFILING === '1'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Only the /client specifier. The profiling bundle itself requires bare
    // `react-dom` to reach ReactDOMSharedInternals, so aliasing that too makes
    // the module self-referential and the dispatcher comes back undefined.
    // `flushSync` is imported from bare `react-dom` and reaches the profiling
    // runtime through those same shared internals, which is the supported path.
    alias: profiling
      ? [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }]
      : [],
  },
  define: {
    __PROFILING__: JSON.stringify(profiling),
  },
})
