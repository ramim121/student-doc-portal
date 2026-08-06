'use client';

import { useState } from 'react';
import { monogramGradient } from '@/lib/monogram';
import { cn } from '@/lib/utils';

/**
 * An institution's logo, falling back to its monogram.
 *
 * The fallback is not only for institutions with no logo: if the image 404s or
 * fails to decode, the tile still has to show something, so a failed load flips
 * back to the monogram rather than leaving an empty box.
 */
export function InstitutionMark({
  id,
  short,
  color,
  hasLogo,
  className,
  textClassName,
}: {
  id: string;
  short: string;
  color?: string | null;
  hasLogo?: boolean;
  className?: string;
  textClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showLogo = Boolean(hasLogo) && !failed;

  if (showLogo) {
    return (
      // Plain <img>: the route streams bytes out of private storage, which the
      // image optimiser cannot fetch on its own.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/universities/${id}/logo`}
        alt={`${short} logo`}
        onError={() => setFailed(true)}
        className={cn(
          'rounded-2xl bg-white object-contain p-1.5 shadow-lg',
          className,
        )}
      />
    );
  }

  return (
    <div
      aria-label={`${short} monogram`}
      className={cn(
        'flex items-center justify-center rounded-2xl bg-gradient-to-br font-bold text-white shadow-lg',
        monogramGradient(color),
        className,
        textClassName,
      )}
    >
      {short}
    </div>
  );
}
