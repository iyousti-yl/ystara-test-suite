import type { ReactNode } from "react";
import { Title } from "@ui5/webcomponents-react";
import { Link } from "react-router";

/**
 * The top of every page: where it sits (breadcrumbs, as a caption), its title,
 * a muted line under it, and the page's buttons on the right. The current page
 * is the title, so the breadcrumbs stop at its parent.
 */
export function PageHeader(props: { crumbs?: { label: string; to: string }[]; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
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
          <Title level="H1" size="H2" wrappingType="Normal">
            {props.title}
          </Title>
          {props.subtitle && <div className="page-header-subtitle">{props.subtitle}</div>}
        </div>
        {props.actions && <div className="page-header-actions">{props.actions}</div>}
      </div>
    </header>
  );
}
