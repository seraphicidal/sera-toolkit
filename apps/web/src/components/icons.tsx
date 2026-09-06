import type { SVGProps } from 'react';

/**
 * The icon set.
 *
 * Hand-drawn on a 24-unit grid rather than pulled from a library: there are nine of
 * them, they share one stroke weight, and shipping an icon package to draw nine shapes
 * would cost more than it saves. Every icon is `aria-hidden`; the meaning lives in the
 * label next to it.
 */

type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

function Icon({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const LinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10.5 13.5a4 4 0 0 0 5.66 0l2.84-2.84a4 4 0 0 0-5.66-5.66l-1.3 1.3" />
    <path d="M13.5 10.5a4 4 0 0 0-5.66 0L5 13.34a4 4 0 1 0 5.66 5.66l1.3-1.3" />
  </Icon>
);

export const ClipboardIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="8" y="3" width="8" height="4" rx="1.4" />
    <path d="M16 5h1.5A1.5 1.5 0 0 1 19 6.5v12A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-12A1.5 1.5 0 0 1 6.5 5H8" />
  </Icon>
);

export const DownloadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3v12" />
    <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
    <path d="M4.5 20.25h15" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.75v5" />
    <path d="M12 16.25h.01" />
  </Icon>
);

export const SpinnerIcon = ({ size = 20, ...props }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    focusable="false"
    className="animate-spin-slow"
    {...props}
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={1.6} opacity={0.22} />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
  </svg>
);

export const SunIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2.5 12h2M19.5 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
  </Icon>
);

export const MoonIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const MonitorIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4.5" width="18" height="12" rx="1.8" />
    <path d="M9 20.5h6M12 16.5v4" />
  </Icon>
);

export const ChevronIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m7 10 5 5 5-5" />
  </Icon>
);

export const VideoIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="6" width="12.5" height="12" rx="2" />
    <path d="m15.5 10.5 5-2.6v8.2l-5-2.6z" />
  </Icon>
);

export const AudioIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 17.5V5.5l10-2v12" />
    <circle cx="6.5" cy="17.5" r="2.5" />
    <circle cx="16.5" cy="15.5" r="2.5" />
  </Icon>
);

export const ImageIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <circle cx="8.75" cy="9.75" r="1.5" />
    <path d="m4 17 4.5-4.5 3.5 3.5 3-3L20 17.5" />
  </Icon>
);

export const GifIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M10 9.75A2.25 2.25 0 1 0 10 14.5h.75v-2" />
    <path d="M13.75 9.5v5M16.5 14.5v-5h2.75M16.5 12h2.25" />
  </Icon>
);
