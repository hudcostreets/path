declare module '*.mdx' {
  import { MDXProps } from 'mdx/types'
  import type { ReactNode } from 'react'

  export * from 'mdx/types'

  export default function MDXContent(props: MDXProps): ReactNode

  export const frontmatter: Record<string, unknown>
}
