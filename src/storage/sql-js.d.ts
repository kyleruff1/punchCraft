/**
 * sql.js ships no types, and `@types/sql.js` would be one more dependency for
 * the five calls `sqlJsPort.ts` makes. This declares only what is imported:
 * the initialiser, in the two builds used — Node's (jest) and the browser's.
 */
declare module 'sql.js' {
  import type { SqlJsDatabase } from '@/storage/sqlJsPort'

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | null) => SqlJsDatabase
  }
  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string
  }): Promise<SqlJsStatic>
}

declare module 'sql.js/dist/sql-wasm-browser.js' {
  import type initSqlJs from 'sql.js'
  const init: typeof initSqlJs
  export default init
}

declare module 'sql.js/dist/sql-wasm-browser.wasm' {
  /** On the web, Metro resolves an asset import to its URL. */
  const url: string
  export default url
}
