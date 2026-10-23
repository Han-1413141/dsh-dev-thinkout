// Native paths are copied unchanged from DSH 0.2.1-rc.2.
const THINK_SVG='<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke-width="1"><path d="M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z" stroke="currentColor"/><path d="M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z" stroke="currentColor"/><path d="M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z" fill="currentColor"/></svg>';
const WHALE_PATH='M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742';
export function progressIcon(style='orbit') {
  if(style==='none')return '';
  if(style==='whale')return `<span class="jev-icon jev-icon-whale" aria-hidden="true"><span class="jev-whale-mask"></span><svg class="jev-whale-still" viewBox="0 0 16 16" fill="none"><path d="${WHALE_PATH}" stroke="currentColor" stroke-width="1"/></svg></span>`;
  if(style==='native')return `<span class="jev-icon jev-icon-native" aria-hidden="true">${THINK_SVG}</span>`;
  return '<span class="jev-icon jev-icon-orbit" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><g class="jev-orbit-rings"><ellipse cx="12" cy="12" rx="9.5" ry="4"/><ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(120 12 12)"/></g><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle class="jev-orbit-dot" cx="21.5" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg></span>';
}

// Fixed vector geometry keeps small UI marks independent of the system font.
const UI_ICON_PATHS=Object.freeze({
  close:'<path d="m4 4 8 8M12 4l-8 8"/>',
  plus:'<path d="M8 3v10M3 8h10"/>',
  minus:'<path d="M3 8h10"/>',
  chevron:'<path d="m4 6 4 4 4-4"/>',
  external:'<path d="M5 3h8v8M13 3 3 13"/>',
  check:'<path d="m3 8 3.25 3.25L13 4.5"/>',
  circle:'<circle cx="8" cy="8" r="4.5"/>',
  dot:'<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
  parallel:'<path d="M5.5 3v10M10.5 3v10"/>',
  next:'<path d="M2.5 8h11M9 3.5 13.5 8 9 12.5"/>',
  revise:'<path d="M5 3 2 6l3 3M2.5 6H9a4 4 0 0 1 0 8H7"/>',
  badge:'<path d="M9.5 5.5v5.25A2.75 2.75 0 0 1 6.75 13.5H6"/><circle cx="9.5" cy="2.5" r=".75" fill="currentColor" stroke="none"/>',
});

export function uiIcon(name){
  if(!Object.hasOwn(UI_ICON_PATHS,name))return '';
  return `<svg class="jev-symbol jev-symbol-${name}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${UI_ICON_PATHS[name]}</svg>`;
}
