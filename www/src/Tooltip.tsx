import { ReactNode, cloneElement, isValidElement, useRef, useState } from "react"
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useHover,
  useFocus,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
  arrow,
  FloatingArrow,
  Placement,
} from "@floating-ui/react"

export function Tooltip({ children, content, placement = "top" }: {
  children: ReactNode
  content: ReactNode
  placement?: Placement
}) {
  const [isOpen, setIsOpen] = useState(false)
  const arrowRef = useRef<SVGSVGElement>(null)
  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 8 }), arrow({ element: arrowRef })],
  })
  const hover = useHover(context, { move: false })
  const focus = useFocus(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: "tooltip" })
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role])

  return (
    <>
      {isValidElement(children)
        ? cloneElement(children as any, { ref: refs.setReference, ...getReferenceProps() })
        : <span ref={refs.setReference} {...getReferenceProps()}>{children}</span>
      }
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="fui-tooltip"
          >
            {content}
            <FloatingArrow ref={arrowRef} context={context} fill="var(--tooltip-bg, #333)" />
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip content={children}>
      <span className="info-icon" tabIndex={0}>&#9432;</span>
    </Tooltip>
  )
}
