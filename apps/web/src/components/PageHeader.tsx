import type { ReactNode } from "react";
import { Breadcrumbs, BreadcrumbsItem, Title } from "@ui5/webcomponents-react";
import { useNavigate } from "react-router";

/** Breadcrumbs, the page title, a line of facts under it, and the page's buttons on the right. */
export function PageHeader(props: { crumbs?: { label: string; to: string }[]; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="page-header">
      {props.crumbs && (
        <Breadcrumbs
          onItemClick={(e) => {
            const href = e.detail.item.href;
            if (href) {
              e.preventDefault();
              navigate(href);
            }
          }}
        >
          {props.crumbs.map((c) => (
            <BreadcrumbsItem key={c.to} href={c.to}>
              {c.label}
            </BreadcrumbsItem>
          ))}
          <BreadcrumbsItem>{typeof props.title === "string" ? props.title : ""}</BreadcrumbsItem>
        </Breadcrumbs>
      )}
      <div className="page-header-row">
        <div>
          <Title level="H2">{props.title}</Title>
          {props.subtitle && <div className="page-header-subtitle">{props.subtitle}</div>}
        </div>
        {props.actions && <div className="page-header-actions">{props.actions}</div>}
      </div>
    </header>
  );
}
