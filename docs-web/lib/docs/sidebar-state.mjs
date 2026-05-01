/**
 * @typedef {{ title: string; slug: string; children?: Array<{ title: string; slug: string }> }} NavItem
 */

/**
 * @param {NavItem[]} navItems
 * @param {string} currentSlug
 * @returns {string[]}
 */
export function getOpenGroupsForSlug(navItems, currentSlug) {
  if (!currentSlug) {
    return [];
  }

  return navItems.flatMap((item) => {
    const hasMatch = item.children?.some((child) => child.slug === currentSlug);
    return hasMatch ? [item.title] : [];
  });
}
