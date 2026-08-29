import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Conditional classes with later Tailwind utilities winning over earlier ones. */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
