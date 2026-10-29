import {
  Fragment,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { BUTTON_CSS } from "./button-css";

const VARIANTS = ["primary", "secondary", "ghost", "destructive"] as const;
const SIZES = ["sm", "md", "lg"] as const;

export type ButtonVariant = (typeof VARIANTS)[number];
export type ButtonSize = (typeof SIZES)[number];

/** Per-component-type stable id, used only to key icon spans when an icon swaps. */
const iconTypeIds = new WeakMap<object, number>();
let nextIconTypeId = 1;

function iconTypeId(icon: ReactNode): number {
  if (!isValidElement(icon) || typeof icon.type === "string") return 0;
  const type = icon.type;
  if (!iconTypeIds.has(type)) iconTypeIds.set(type, nextIconTypeId++);
  return iconTypeIds.get(type) as number;
}

/** Hide broken <img> icons instead of showing the browser's broken-image glyph. */
function hideBrokenImage(event: React.SyntheticEvent<HTMLSpanElement>): void {
  if (event.target instanceof HTMLImageElement) {
    event.target.style.visibility = "hidden";
  }
}

function LoadingSpinner(): ReactNode {
  return (
    <svg
      className="ui-button__spinner"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="8.5" opacity={0.2} />
      <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" />
    </svg>
  );
}

export interface ButtonProps extends Omit<HTMLAttributes<HTMLButtonElement>, "onClick" | "onPointerEnter"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the left icon and swallows clicks. */
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPointerEnter?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  type?: "button" | "submit" | "reset";
  ref?: Ref<HTMLButtonElement>;
  style?: CSSProperties;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  iconRight,
  children,
  className,
  disabled,
  onClick,
  onPointerEnter,
  type = "button",
  ref,
  ...rest
}: ButtonProps): ReactNode {
  const labelText = typeof children === "string" ? children : undefined;
  const hasLabel = children != null && children !== false && children !== "";
  const iconOnly = !hasLabel && !!(icon || iconRight);
  const safeVariant: ButtonVariant = (VARIANTS as readonly string[]).includes(variant) ? variant : "primary";
  const safeSize: ButtonSize = (SIZES as readonly string[]).includes(size) ? size : "md";

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const previousWidthRef = useRef<number>(0);
  const [ready, setReady] = useState<boolean>(false);

  useEffect(() => setReady(true), []);

  const contentKey = `${labelText ?? "label"}|${loading && icon ? "spinner" : iconTypeId(icon)}|${iconTypeId(iconRight)}`;
  const previousKeyRef = useRef<string>(contentKey);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) return;

    const width = button.getBoundingClientRect().width;
    const previousWidth = previousWidthRef.current;
    const keyChanged = previousKeyRef.current !== contentKey;

    previousWidthRef.current = width;
    previousKeyRef.current = contentKey;

    if (!keyChanged || !previousWidth || Math.abs(previousWidth - width) < 0.5) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    button.animate([{ width: `${previousWidth}px` }, { width: `${width}px` }], {
      duration: 480,
      easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    });
  });

  return (
    <Fragment>
      <style href="ui-button" precedence="default">
        {BUTTON_CSS}
      </style>
      <button
        type={type}
        className={["ui-button", className].filter(Boolean).join(" ")}
        data-variant={safeVariant}
        data-size={safeSize}
        data-loading={loading || undefined}
        data-icon-only={iconOnly || undefined}
        data-ready={ready || undefined}
        ref={(node: HTMLButtonElement | null): void => {
          buttonRef.current = node;
          if (typeof ref === "function") {
            ref(node);
          } else if (ref) {
            ref.current = node;
          }
        }}
        disabled={disabled}
        aria-busy={loading || undefined}
        aria-disabled={loading || undefined}
        onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
          if (loading) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
        onPointerEnter={(event: React.PointerEvent<HTMLButtonElement>): void => {
          const label = event.currentTarget.querySelector(".ui-button__label");
          if (label && labelText && !rest.title) {
            (label as HTMLElement).title =
              (label as HTMLElement).scrollWidth > (label as HTMLElement).clientWidth + 1 ? labelText : "";
          }
          onPointerEnter?.(event);
        }}
        {...rest}
      >
        {icon && (
          <span
            key={`icon-${loading && icon ? "spinner" : iconTypeId(icon)}`}
            className="ui-button__icon"
            aria-hidden="true"
            onErrorCapture={hideBrokenImage}
          >
            {loading ? <LoadingSpinner /> : icon}
          </span>
        )}
        {hasLabel && (
          <span key={`label-${labelText ?? "label"}`} className="ui-button__label" data-text={labelText} dir="auto">
            {children}
          </span>
        )}
        {iconRight && (
          <span
            key={`icon-right-${iconTypeId(iconRight)}`}
            className="ui-button__icon"
            aria-hidden="true"
            onErrorCapture={hideBrokenImage}
          >
            {iconRight}
          </span>
        )}
      </button>
    </Fragment>
  );
}
