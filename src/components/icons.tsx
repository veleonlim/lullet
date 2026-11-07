import type { ReactNode, SVGProps } from "react";
import type { CategoryId } from "@/lib/ledger";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { title?: string };

/** 24px outline icons; decorative unless a title is given. */
function Icon({ title, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      {...props}
    >
      {children}
    </svg>
  );
}

export function ReceiptIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </Icon>
  );
}

export function ScaleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4v16M8 20h8M5 7h14" />
      <path d="M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m15 6-6 6 6 6" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3 2.5 20h19z" />
      <path d="M12 10v4M12 17v.5" />
    </Icon>
  );
}

const CATEGORY_PATHS: Record<CategoryId, ReactNode> = {
  food: <path d="M7 3v8M4 3v4a3 3 0 0 0 6 0V3M7 11v10M17 21V3c-2.5 1.2-4 4-4 8h4" />,
  transport: (
    <>
      <path d="M5 16V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10zM5 11h14" />
      <path d="M7 16v3M17 16v3" />
      <circle cx="8.5" cy="13.5" r=".6" />
      <circle cx="15.5" cy="13.5" r=".6" />
    </>
  ),
  stay: (
    <>
      <path d="M3 19V6M3 15h18v4M21 15v-2a3 3 0 0 0-3-3h-8v5" />
      <circle cx="6.5" cy="11.5" r="1.5" />
    </>
  ),
  sightseeing: <path d="M3 21h18M5 21V10M9.5 21V10M14.5 21V10M19 21V10M3 10l9-6 9 6" />,
  shopping: <path d="M6 8h12l1 12H5zM9 8V6.5a3 3 0 0 1 6 0V8" />,
  other: (
    <>
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18" cy="12" r="1.2" />
    </>
  ),
};

export function CategoryIcon({ category, ...props }: IconProps & { category: CategoryId }) {
  return <Icon {...props}>{CATEGORY_PATHS[category]}</Icon>;
}
