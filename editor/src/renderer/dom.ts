export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const { class: cls, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (cls) node.className = cls;
  node.append(...children);
  return node;
}
