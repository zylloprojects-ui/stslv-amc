import { initialsOf } from './clientAvatarHelpers'

/** A soft tile with the client's initials. Decorative: the name is always written next to it. */
export function ClientAvatar({ name, className = 'h-10 w-10 text-sm' }: { name: string; className?: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-100 via-sky-50 to-white font-bold tracking-wide text-[#0b3b66] shadow-sm ring-1 ring-inset ring-sky-200 ${className}`}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  )
}
