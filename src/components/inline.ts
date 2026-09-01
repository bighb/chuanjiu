/** 把散文字段渲染成 HTML：先转义，再把 **x** 变成强调。 */
export function inline(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong class="hl">$1</strong>');
}
