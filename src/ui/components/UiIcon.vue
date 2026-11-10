<script setup lang="ts">
/**
 * 内联 SVG 图标集：不依赖任何外部 CDN，离线单文件包内自洽。
 * 全部按 16×16 画布绘制，线宽 1.2，颜色跟随 currentColor。
 */
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 })

const PATHS: Record<string, string> = {
  table: '<rect x="2.5" y="5" width="11" height="6" rx="1.4"/><path d="M5 5V3.4M11 5V3.4"/>',
  host: '<rect x="2" y="5.5" width="12" height="5" rx="1.2"/><path d="M4 5.5V3.8M8 5.5V3.8M12 5.5V3.8"/>',
  podium: '<path d="M4 13h8M5.5 13V7.5h5V13M6.5 7.5V5h3v2.5"/>',
  lectern: '<path d="M6 13h4M8 13V7M4.5 7h7L10 4H6z"/>',
  aisle: '<path d="M5.5 2.5v11M10.5 2.5v11"/><path d="M7 5h2M7 8h2M7 11h2" opacity=".55"/>',
  zone: '<rect x="2.5" y="3.5" width="11" height="9" rx="1" stroke-dasharray="2.5 2"/>',
  label: '<path d="M3 8.5V3.2h5.3l4.7 4.7-5.1 5.1z"/><circle cx="5.6" cy="5.8" r=".8"/>',
  square: '<rect x="3" y="3" width="10" height="10" rx="1.2"/>',
  border: '<rect x="2.5" y="2.5" width="11" height="11" rx=".8" stroke-width="1.6"/><path d="M8 2.5v11M2.5 8h11" opacity=".3"/>',
  rect: '<rect x="1.8" y="4.4" width="12.4" height="7.2" rx="1.2"/>',
  circle: '<circle cx="8" cy="8" r="5.2"/>',
  diamond: '<path d="M8 2.6 13.4 8 8 13.4 2.6 8z"/>',
  triangle: '<path d="M8 3 13.4 12.8H2.6z"/>',
  undo: '<path d="M5 6h5a4 4 0 0 1 0 8H8M5 6l3-3M5 6l3 3"/>',
  redo: '<path d="M11 6H6a4 4 0 0 0 0 8h2M11 6 8 3M11 6 8 9"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  paste: '<path d="M5.5 3.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-1.5"/><rect x="5.5" y="2" width="5" height="3" rx="1"/>',
  duplicate: '<rect x="2.5" y="2.5" width="8" height="8" rx="1.2"/><path d="M5.5 13.5h7a1 1 0 0 0 1-1v-7"/>',
  trash: '<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8M7 7v3.5M9 7v3.5"/>',
  alignLeft: '<path d="M2 2v12M5 4h8M5 9h5"/>',
  alignHCenter: '<path d="M8 2v12M4 4h8M5.5 9h5"/>',
  alignRight: '<path d="M14 2v12M3 4h8M6 9h5"/>',
  alignTop: '<path d="M2 2h12M4 5v8M9 5v4"/>',
  alignVCenter: '<path d="M2 8h12M4 4v8M9 5.5v5"/>',
  alignBottom: '<path d="M2 14h12M4 3v8M9 7v4"/>',
  distH: '<path d="M2 2v12M14 2v12M5 5h2v6H5zM9 5h2v6H9z"/>',
  distV: '<path d="M2 2h12M2 14h12M5 5v2h6V5zM5 9v2h6V9z"/>',
  front: '<rect x="2.5" y="2.5" width="7" height="7" rx="1"/><path d="M6.5 6.5h7v7h-7z" fill="currentColor" fill-opacity=".18"/>',
  back: '<rect x="6.5" y="6.5" width="7" height="7" rx="1"/><path d="M2.5 9.5v-7h7"/>',
  up: '<path d="M8 13V3M4.5 6.5 8 3l3.5 3.5"/>',
  down: '<path d="M8 3v10M4.5 9.5 8 13l3.5-3.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  fit: '<path d="M2.5 6V3.5A1 1 0 0 1 3.5 2.5H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10"/>',
  expand: '<path d="M9 3h4v4M13 3 9.5 6.5M7 13H3V9M3 13l3.5-3.5"/>',
  grid: '<path d="M2.5 6h11M2.5 10h11M6 2.5v11M10 2.5v11"/>',
  layers: '<path d="M8 2.5 13 5 8 7.5 3 5zM3 8l5 2.5L13 8M3 11l5 2.5L13 11"/>',
  sliders: '<path d="M4 3v10M8 3v10M12 3v10"/><circle cx="4" cy="6" r="1.4" fill="currentColor" fill-opacity=".2"/><circle cx="8" cy="10" r="1.4" fill="currentColor" fill-opacity=".2"/><circle cx="12" cy="5" r="1.4" fill="currentColor" fill-opacity=".2"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  chevronDown: '<path d="M4 6.5 8 10.5l4-4"/>',
  chevronLeft: '<path d="M10 4 6 8l4 4"/>',
  chevronRight: '<path d="M6 4l4 4-4 4"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7"/>',
  unlock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.5a2.5 2.5 0 0 1 4.8-.8"/>',
  rotate: '<path d="M13 8a5 5 0 1 1-1.4-3.4M13 2.5V5h-2.5"/>',
  import: '<path d="M8 2.5v8M5 7.5 8 10.5l3-3M3 13.5h10"/>',
  export: '<path d="M8 10.5v-8M5 5.5 8 2.5l3 3M3 13.5h10"/>',
  save: '<path d="M3 3h8l2 2v8H3z"/><path d="M5.5 3v3h5V3M5.5 13v-4h5v4"/>',
  edit: '<path d="M10.5 3.5 12.5 5.5 6 12H4v-2z"/><path d="M9.5 4.5 11.5 6.5"/>',
  settings: '<g transform="translate(8 8) scale(.6667) translate(-12 -12)" stroke-width="1.8"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></g>',
  users: '<circle cx="6" cy="5.5" r="2.2"/><path d="M2.5 13c0-2 1.6-3.2 3.5-3.2s3.5 1.2 3.5 3.2"/><path d="M10.5 4.2a2 2 0 0 1 0 3.8M11.5 9.8c1.4.3 2.2 1.4 2.2 3"/>',
  layout: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.2"/><path d="M7 2.5v11M7 8h6.5"/>',
  project: '<path d="M3 4.5h4l1.2 1.5H13v7.5H3z"/><path d="M3 4.5V3h4l1 1.5"/>',
  search: '<circle cx="7" cy="7" r="3.8"/><path d="m10 10 3 3"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  print: '<path d="M4.5 6V3h7v3"/><rect x="2.5" y="6" width="11" height="5" rx="1"/><path d="M4.5 11v2.5h7V11"/>',
  image: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.2"/><circle cx="6" cy="6.5" r="1"/><path d="m3.5 11 3.2-3 2.3 2 2-1.6 1.6 1.4"/>',
  backup: '<path d="M8 2.5v8M5 7.5 8 10.5l3-3M3 13.5h10"/>',
  restore: '<path d="M8 13.5v-8M5 8.5 8 5.5l3 3M3 2.5h10"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.2 1.5"/>',
  grip: '<path d="M6 4h.01M6 8h.01M6 12h.01M10 4h.01M10 8h.01M10 12h.01" stroke-width="2" stroke-linecap="round"/>',
  more: '<path d="M4 8h.01M8 8h.01M12 8h.01" stroke-width="2" stroke-linecap="round"/>',
  seat: '<path d="M5 3v5.5M11 3v5.5M4 8.5h8V13H4z"/><path d="M5.5 13v1M10.5 13v1"/>',
  empty: '<rect x="3" y="4.5" width="10" height="7" rx="1.2" stroke-dasharray="2.5 2"/>',
  warning: '<path d="M8 2.8 13.5 12.5h-11z"/><path d="M8 6.5v3M8 11h.01" stroke-linecap="round"/>',
  list: '<path d="M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01" stroke-linecap="round"/>',
  download: '<path d="M8 2.5v8M5 7.5 8 10.5l3-3M3 13.5h10"/>',
  render: '<path d="M2.5 8s2-3.5 5.5-3.5S13.5 8 13.5 8s-2 3.5-5.5 3.5S2.5 8 2.5 8z"/><circle cx="8" cy="8" r="1.6"/>',
  selectAll: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.2" stroke-dasharray="2.5 1.6"/><path d="m5.5 8.4 1.8 1.8 3.2-3.8"/>',
  cursor: '<path d="M4 2.8 12 7.6l-3.6 1.2L7 12.7z"/>',
  text: '<path d="M4 4h8M8 4v8M6.5 12h3"/>',
  font: '<path d="M3.5 13 8 3l4.5 10M5.5 9.5h5"/>',
  palette: '<path d="M8 2.6a5.4 5.4 0 0 1 0 10.8c-1 0-1.4-.8-1-1.7.5-1-.2-1.8-1.4-1.8H4a1.4 1.4 0 0 1-1.4-1.4A5.4 5.4 0 0 1 8 2.6z"/><circle cx="6" cy="6" r=".9"/><circle cx="9.5" cy="5.4" r=".9"/><circle cx="10.6" cy="8.4" r=".9"/>'
}
</script>

<template>
  <svg
    class="ico"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.2"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <g v-html="PATHS[name] ?? PATHS.more" />
  </svg>
</template>
