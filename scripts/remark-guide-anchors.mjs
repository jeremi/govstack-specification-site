import { visit } from 'unist-util-visit';

const EMPTY_ANCHOR = /^<a\s+([^>]+)><\/a>$/i;
const OPEN_ANCHOR = /^<a\s+([^>]+)>$/i;
const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;

function explicitAnchor(value) {
  const match = EMPTY_ANCHOR.exec(value.trim()) ?? OPEN_ANCHOR.exec(value.trim());
  if (!match) return undefined;

  const attributes = Object.fromEntries(
    [...match[1].matchAll(ATTRIBUTE)].map((attribute) => [attribute[1].toLowerCase(), attribute[3]]),
  );
  if (!attributes.id || attributes.href !== `#${attributes.id}`) return undefined;
  return attributes.id;
}

export default function remarkGuideAnchors() {
  return (tree) => {
    visit(tree, 'heading', (node) => {
      const anchorChildren = [];
      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        if (child.type !== 'html') continue;
        const id = explicitAnchor(child.value);
        if (!id) continue;
        const compound = EMPTY_ANCHOR.test(child.value.trim());
        const closing = node.children[index + 1];
        if (!compound && !(closing?.type === 'html' && closing.value.trim().toLowerCase() === '</a>')) continue;
        anchorChildren.push({ index, id, count: compound ? 1 : 2 });
      }

      if (anchorChildren.length === 0) return;
      if (anchorChildren.length > 1) {
        throw new Error('A heading may contain only one explicit guide anchor.');
      }

      const [{ index, id, count }] = anchorChildren;
      node.data ??= {};
      node.data.hProperties = { ...node.data.hProperties, id };
      node.children.splice(index, count);
      const lastChild = node.children.at(-1);
      if (lastChild?.type === 'text') lastChild.value = lastChild.value.trimEnd();
    });
  };
}

