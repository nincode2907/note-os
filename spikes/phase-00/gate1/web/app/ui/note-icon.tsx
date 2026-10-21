type IconName = 'bold' | 'italic' | 'strike' | 'heading' | 'bullets' | 'numbered' | 'checklist' | 'quote' | 'code' | 'mic' | 'more' | 'pin';

const paths: Record<IconName, React.ReactNode> = {
  bold: <path d="M7 5h6a4 4 0 0 1 0 8H7zm0 8h7a4 4 0 0 1 0 8H7z" />,
  italic: <><path d="M14 4h6M4 20h6M15 4 9 20" /></>,
  strike: <><path d="M7 5h8a4 4 0 0 1 2.8 6.9M5 19a4 4 0 0 0 3 1h8a4 4 0 0 0 2.7-6.9M3 12h18" /></>,
  heading: <><path d="M5 5v14M19 5v14M5 12h14" /><path d="M21 7v3" /></>,
  bullets: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
  numbered: <><path d="M10 6h10M10 12h10M10 18h10" /><path d="M4 5h2v4M4 9h2M4 13h2l-2 3h2M4 20h2" /></>,
  checklist: <><path d="m4 6 1.5 1.5L8 5M11 6h9M4 13l1.5 1.5L8 12M11 13h9M4 20h4M11 20h9" /></>,
  quote: <><path d="M4 11h6v7H3v-5c0-4 2-7 6-9M14 11h6v7h-7v-5c0-4 2-7 6-9" /></>,
  code: <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" /></>,
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  pin: <><path d="m16 3 5 5-4 1-4 4-1 6-2-2-2-2-2-2 6-1 4-4zM5 19l-2 2" /></>,
};

export function NoteIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
