/// <reference types="vite/client" />
/// <reference types="vite-plugin-dvc/client" />

declare module 'plotly.js-dist-min' {
  import Plotly from 'plotly.js'
  export default Plotly
}

declare module 'plotly.js/basic' {
  import Plotly from 'plotly.js'
  export default Plotly
}
