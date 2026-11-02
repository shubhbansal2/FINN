import type { SVGProps } from 'react';

/**
 * Small, consistent line-icon set (1.5px stroke on a 20px grid). Icons are
 * decorative by default (aria-hidden); anything that needs a name gets it from
 * the surrounding control's label, not from the icon.
 */
const PATHS = {
  search: 'M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM13.7 13.7 17.5 17.5',
  close: 'M5 5l10 10M15 5 5 15',
  arrowUp: 'M10 16V4M5 9l5-5 5 5',
  arrowDown: 'M10 4v12M5 11l5 5 5-5',
  arrowRight: 'M4 10h12M11 5l5 5-5 5',
  external: 'M11 4h5v5M16 4l-7 7M14 11.5V16H4V6h4.5',
  chevronDown: 'M5 7.5l5 5 5-5',
  chevronRight: 'M7.5 5l5 5-5 5',
  clock: 'M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM10 6v4.25l2.75 1.75',
  alert: 'M10 3 18 17H2L10 3ZM10 8.5v3.5M10 14.25v.25',
  info: 'M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM10 9v5M10 6.25v.25',
  document: 'M5 2.75h6.5L15 6.25V17.25H5V2.75ZM11.5 2.75v3.5H15M7.5 10h5M7.5 13h5',
  brief: 'M3.5 4.5h13M3.5 8.5h13M3.5 12.5h8M3.5 16.5h8',
  research: 'M4 3.5h8.5L16 7v9.5H4v-13ZM8.5 13.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM10.2 12.7l2.3 2.3',
  bell: 'M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 2h-13l1.5-2ZM8.25 17.5h3.5',
  settings: 'M3.5 6h8M14.5 6h2M3.5 14h2M8.5 14h8M13 4.25v3.5M7 12.25v3.5',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  minus: 'M5 10h10',
  list: 'M7.5 5h9M7.5 10h9M7.5 15h9M3.5 5h1M3.5 10h1M3.5 15h1',
  command: 'M3.5 6.5l3 3.5-3 3.5M9.5 14h7',
} as const;

export type IconName = keyof typeof PATHS;

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  name: IconName;
  size?: number;
};

export function Icon({ name, size = 20, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
