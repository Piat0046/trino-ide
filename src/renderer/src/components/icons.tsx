// 16px 스트로크 아이콘 (currentColor). IDE 크롬용 최소 세트.
interface IconProps {
  size?: number
}

function svg(path: JSX.Element, size = 16): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

export const IconDatabase = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </>,
    size
  )

export const IconBookmark = ({ size }: IconProps): JSX.Element =>
  svg(<path d="M6 4h12v16l-6-4-6 4V4z" />, size)

export const IconClock = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>,
    size
  )

export const IconPlay = ({ size }: IconProps): JSX.Element =>
  svg(<path d="M7 5l11 7-11 7V5z" fill="currentColor" stroke="none" />, size)

export const IconStop = ({ size }: IconProps): JSX.Element =>
  svg(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />, size)

export const IconPlus = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>,
    size
  )

export const IconSave = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M5 4h11l3 3v13H5V4z" />
      <path d="M8 4v5h7V4" />
      <path d="M8 20v-6h8v6" />
    </>,
    size
  )

export const IconFormat = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 6h16" />
      <path d="M8 10h12" />
      <path d="M4 14h12" />
      <path d="M8 18h8" />
    </>,
    size
  )

export const IconChevronLeft = ({ size }: IconProps): JSX.Element =>
  svg(<path d="M15 6l-6 6 6 6" />, size)

export const IconChevronRight = ({ size }: IconProps): JSX.Element =>
  svg(<path d="M9 6l6 6-6 6" />, size)

export const IconX = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>,
    size
  )
