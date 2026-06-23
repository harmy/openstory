type GenerateSequenceIconProps = {
  className?: string;
};

export const GenerateSequenceIcon: React.FC<GenerateSequenceIconProps> = ({
  className,
}) => {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Layered shots with forward motion */}
      <rect
        x="1"
        y="4"
        width="7"
        height="8"
        rx="1"
        fill="currentColor"
        opacity="0.3"
      />
      <rect
        x="4"
        y="4"
        width="7"
        height="8"
        rx="1"
        fill="currentColor"
        opacity="0.5"
      />
      <rect x="7" y="4" width="7" height="8" rx="1" fill="currentColor" />
      {/* Play/forward indicator */}
      <path d="M10 8L12 9.5L10 11V8Z" fill="rgba(24, 24, 27, 1)" />
    </svg>
  );
};
