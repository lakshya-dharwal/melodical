import { useId } from "react";

/**
 * Melodical mark: an "M" whose middle dips into a cradle, holding a microphone.
 * Rendered as glossy mango-yellow tube with a chrome rim and a specular highlight,
 * the same layered build as a glass/steel 3D icon.
 */
export function Logo({ size = 44 }: { size?: number }) {
  const id = useId().replace(/:/g, "");
  const M = "M12 53 V20 Q16 46 32 46 Q48 46 52 20 V53";
  const micBody = "M32 9 V21"; // capsule drawn as a fat round-capped line
  const micCradle = "M24 17 Q24 30 32 30 Q40 30 40 17";
  const micStem = "M32 30 V35";

  const Layer = ({ d, w }: { d: string; w: number }) => (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      {/* drop shadow */}
      <path d={d} stroke="#000" strokeOpacity="0.55" strokeWidth={w + 4} transform="translate(0 2.2)" filter={`url(#${id}-blur)`} />
      {/* chrome rim */}
      <path d={d} stroke={`url(#${id}-rim)`} strokeWidth={w + 2.6} />
      {/* mango body */}
      <path d={d} stroke={`url(#${id}-body)`} strokeWidth={w} />
      {/* inner shade along the lower edge */}
      <path d={d} stroke="#B35A00" strokeOpacity="0.45" strokeWidth={w * 0.5} transform="translate(0 1.4)" />
      <path d={d} stroke={`url(#${id}-body)`} strokeWidth={w * 0.62} transform="translate(0 -0.4)" />
      {/* specular highlight */}
      <path d={d} stroke="#FFFBEA" strokeOpacity="0.85" strokeWidth={w * 0.22} transform="translate(-0.6 -1.6)" filter={`url(#${id}-soft)`} />
    </g>
  );

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Melodical">
      <defs>
        <linearGradient id={`${id}-body`} gradientUnits="userSpaceOnUse" x1="0" y1="4" x2="0" y2="58">
          <stop offset="0" stopColor="#FFF2A8" />
          <stop offset="0.28" stopColor="#FFD23A" />
          <stop offset="0.62" stopColor="#FFB000" />
          <stop offset="1" stopColor="#F08400" />
        </linearGradient>
        <linearGradient id={`${id}-rim`} gradientUnits="userSpaceOnUse" x1="6" y1="4" x2="58" y2="60">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.35" stopColor="#C9B58A" />
          <stop offset="0.6" stopColor="#5E4A26" />
          <stop offset="0.85" stopColor="#E9DDB8" />
          <stop offset="1" stopColor="#7A5A1E" />
        </linearGradient>
        <filter id={`${id}-blur`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
        <filter id={`${id}-soft`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.35" />
        </filter>
      </defs>
      <Layer d={M} w={7.5} />
      <Layer d={micCradle} w={3} />
      <Layer d={micStem} w={3} />
      <Layer d={micBody} w={9.5} />
      {/* grille lines on the capsule */}
      <g stroke="#B35A00" strokeOpacity="0.5" strokeWidth="0.8" strokeLinecap="round">
        <path d="M29.4 12.6 H34.6" />
        <path d="M29.2 15.4 H34.8" />
        <path d="M29.4 18.2 H34.6" />
      </g>
    </svg>
  );
}
