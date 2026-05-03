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
            className="flex w-full items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-[#4b4b4b] transition-colors hover:bg-[#efefef] hover:text-black"
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
          className={`block rounded-full px-3 py-2 text-sm transition-colors ${
            isActive
              ? "bg-black font-medium text-white"
              : "text-[#4b4b4b] hover:bg-[#efefef] hover:text-black"
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
        className="fixed left-4 top-20 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-white text-black shadow-[rgba(0,0,0,0.16)_0px_2px_8px_0px] transition-colors hover:bg-[#f3f3f3] lg:hidden"
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
              className="fixed inset-0 z-30 bg-black/50 lg:hidden"
            />
            <motion.aside
              initial={{ x: -300 }}
              animate={{ x: 0 }}
              exit={{ x: -300 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed bottom-0 left-0 top-16 z-40 w-72 overflow-y-auto bg-white p-4 shadow-[rgba(0,0,0,0.16)_0px_4px_16px_0px] lg:hidden"
            >
              {navContent}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Desktop sidebar */}
      <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-64 flex-shrink-0 overflow-y-auto border-r border-[#e2e2e2] p-4 lg:flex">
        {navContent}
      </aside>
    </>
  );
}
