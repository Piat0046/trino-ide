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

export const IconAlertTriangle = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 3.5 21 19H3L12 3.5z" />
      <path d="M12 9.5v4.5" />
      <path d="M12 17.2v.05" />
    </>,
    size
  )

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

export const IconSplit = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
      <path d="M12 5v14" />
    </>,
    size
  )

export const IconCode = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M9 8l-4 4 4 4" />
      <path d="M15 8l4 4-4 4" />
    </>,
    size
  )

export const IconSearch = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>,
    size
  )

export const IconColumns = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
      <path d="M10 5v14" />
      <path d="M15 5v14" />
    </>,
    size
  )

export const IconCopy = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 012-2h8" />
    </>,
    size
  )

export const IconDownload = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 4v11" />
      <path d="M7 11l5 5 5-5" />
      <path d="M5 20h14" />
    </>,
    size
  )

export const IconArrowUp = ({ size }: IconProps): JSX.Element =>
  svg(<path d="M12 19V5M6 11l6-6 6 6" />, size)

export const IconArrowDown = ({ size }: IconProps): JSX.Element =>
  svg(<path d="M12 5v14M6 13l6 6 6-6" />, size)

export const IconEyeOff = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M4 4l16 16" />
    </>,
    size
  )

export const IconChevronLeft = ({ size }: IconProps): JSX.Element =>
  svg(<path d="M15 6l-6 6 6 6" />, size)

export const IconChevronRight = ({ size }: IconProps): JSX.Element =>
  svg(<path d="M9 6l6 6-6 6" />, size)

export const IconChevronDown = ({ size }: IconProps): JSX.Element =>
  svg(<path d="M6 9l6 6 6-6" />, size)

export const IconTrash = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="M7 7l1 13h8l1-13" />
    </>,
    size
  )

export const IconX = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>,
    size
  )

export const IconLayers = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>,
    size
  )

export const IconPencil = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 20h4L18 10l-4-4L4 16v4z" />
      <path d="M13 7l4 4" />
    </>,
    size
  )

export const IconRefresh = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v6h-6" />
    </>,
    size
  )

// 인스펙터 우측 레일용
export const IconInfo = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>,
    size
  )

export const IconSparkles = ({ size }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
      <path d="M18 15l.7 1.8L20.5 17.5l-1.8.7L18 20l-.7-1.8L15.5 17.5l1.8-.7z" />
    </>,
    size
  )
