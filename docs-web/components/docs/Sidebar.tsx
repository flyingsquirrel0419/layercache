"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { docsNav, NavItem } from "@/lib/docs-config";
import { getOpenGroupsForSlug } from "@/lib/docs/sidebar-state.mjs";

interface SidebarProps {
  currentSlug: string;
}

export default function Sidebar({ currentSlug }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(getOpenGroupsForSlug(docsNav, currentSlug))
  );

  useEffect(() => {
    const activeGroups = getOpenGroupsForSlug(docsNav, currentSlug);
    if (activeGroups.length === 0) {
      return;
    }

    setOpenGroups((prev) => {
      const next = new Set(prev);
      activeGroups.forEach((group) => next.add(group));
      return next;
    });
  }, [currentSlug]);

  const toggleGroup = (title: string) => {
    const newOpenGroups = new Set(openGroups);
    if (newOpenGroups.has(title)) {
      newOpenGroups.delete(title);
    } else {
      newOpenGroups.add(title);
    }
    setOpenGroups(newOpenGroups);
  };

  const renderNavItem = (item: NavItem, isChild = false) => {
    const hasChildren = item.children && item.children.length > 0;

    if (hasChildren) {
      const isOpen = openGroups.has(item.title);
      return (
        <div key={item.title} className={isChild ? "ml-0" : ""}>
          <button
            onClick={() => toggleGroup(item.title)}
            className="w-full flex items-center gap-2 py-2 px-3 text-xs font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary transition-colors"
          >
            <motion.svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              animate={{ rotate: isOpen ? 90 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <polyline points="9 18 15 12 9 6" />
            </motion.svg>
            {item.title}
          </button>
          <AnimatePresence initial={false}>
            {isOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="pl-2">
                  {item.children!.map((child) => renderNavItem(child, true))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      );
    }

    if (item.slug) {
      const isActive = currentSlug === item.slug;
      return (
        <Link
          key={item.slug}
          href={`/docs/${item.slug}`}
          className={`block py-1.5 px-3 rounded-md text-sm transition-colors ${
            isActive
              ? "bg-accent/10 text-accent font-medium"
              : "text-text-secondary hover:text-text-primary hover:bg-surface"
          }`}
          onClick={() => setMobileOpen(false)}
        >
          {item.title}
        </Link>
      );
    }

    return null;
  };

  const navContent = (
    <nav className="space-y-1">
      {docsNav.map((item) => renderNavItem(item))}
    </nav>
  );

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-20 left-4 z-30 w-10 h-10 rounded-lg bg-surface border border-border flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors shadow-sm"
        aria-label="Open sidebar"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
              className="lg:hidden fixed inset-0 bg-black/50 z-30"
            />
            <motion.aside
              initial={{ x: -300 }}
              animate={{ x: 0 }}
              exit={{ x: -300 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="lg:hidden fixed left-0 top-16 bottom-0 w-64 bg-background border-r border-border z-40 overflow-y-auto p-4"
            >
              {navContent}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 flex-shrink-0 border-r border-border h-[calc(100vh-4rem)] sticky top-16 overflow-y-auto p-4">
        {navContent}
      </aside>
    </>
  );
}
