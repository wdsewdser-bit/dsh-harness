export function cycles(edges) {
  const nodes = [...new Set([...edges.keys(), ...[...edges.values()].flatMap(set => [...set])])].sort();
  let index = 0;
  const indices = new Map(), low = new Map(), stack = [], onStack = new Set(), components = [];
  const visit = node => {
    indices.set(node, index); low.set(node, index); index++;
    stack.push(node); onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop(); onStack.delete(member); component.push(member);
      } while (member !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const node of nodes) if (!indices.has(node)) visit(node);
  return components;
}
