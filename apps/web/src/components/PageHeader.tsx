import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Title, type TitleDomRef } from "@ui5/webcomponents-react";
import { Link } from "react-router";

/**
 * The top of every page: where it sits (breadcrumbs, as a caption), its title,
 * a muted line under it, and the page's buttons on the right. The current page
 * is the title, so the breadcrumbs stop at its parent.
 *
 * The title also names the browser tab ("Monthly sales · Ystara"; `tabTitle`
 * when the title isn't plain text), and on arriving at another page the
 * keyboard focus moves to it, so a screen reader reads out the new page.
 */
export function PageHeader(props: { crumbs?: { label: string; to: string }[]; title: ReactNode; tabTitle?: string; subtitle?: ReactNode; actions?: ReactNode }) {
  const tabTitle = props.tabTitle ?? (typeof props.title === "string" ? props.title : undefined);
  const heading = useRef<TitleDomRef>(null);
  useDocumentTitle(tabTitle);
  useFocusOnArrival(heading, tabTitle);
  return (
    <header className="page-header">
      {props.crumbs && props.crumbs.length > 0 && (
        <nav className="crumbs caption" aria-label="Breadcrumb">
          <ol>
            {props.crumbs.map((c) => (
              <li key={c.to}>
                <Link to={c.to}>{c.label}</Link>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="page-header-row">
        <div className="page-header-text">
          <Title ref={heading} tabIndex={-1} level="H1" size="H2" wrappingType="Normal">
            {props.title}
          </Title>
          {props.subtitle && <div className="page-header-subtitle">{props.subtitle}</div>}
        </div>
        {props.actions && <div className="page-header-actions">{props.actions}</div>}
      </div>
    </header>
  );
}

/** "Monthly sales · Ystara" in the browser tab while the page is open, or just "Ystara" (a title that names Ystara itself stays as it is). */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    document.title = !title ? "Ystara" : title.includes("Ystara") ? title : `${title} · Ystara`;
    return () => {
      document.title = "Ystara";
    };
  }, [title]);
}

/** Whether a page was shown before in this tab: the first one leaves the focus where the browser puts it. */
let arrived = false;

/**
 * Focuses the page's title when another page opens (a new title): a page's own tabs keep their title, so
 * switching tabs leaves the focus on the tab.
 */
function useFocusOnArrival(heading: RefObject<TitleDomRef | null>, title: string | undefined) {
  useEffect(() => {
    if (arrived) heading.current?.focus();
    arrived = true;
  }, [heading, title]);
}
