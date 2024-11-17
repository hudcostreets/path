declare module '*.mdx' {
  import type { ComponentProps, ReactNode } from 'react'
  import { MDXProps } from 'mdx/types'

  export * from 'mdx/types'

  export default function MDXContent(props: MDXProps): ReactNode

  export const frontmatter: Record<string, unknown>
}
