import { Link, useLocation } from "react-router";

type Props = {
  activePage: "home" | "products" | "analytics" | "docs";
};

export function AppBanner({ activePage: _ }: Props) {
  const { pathname } = useLocation();

  const navLink = (to: string, label: string) => (
    <Link to={to} className={pathname === to ? "pm-active" : ""}>
      {label}
    </Link>
  );

  return (
    <div className="pm-banner pm-noise">
      <div className="pm-banner-left">
        <div className="pm-logo-sm">
          <svg width="18" height="18" viewBox="0 0 27 27" fill="none">
            <polyline
              points="3,20 9,13 14,16 23,6"
              stroke="rgba(224,213,188,0.55)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="23" cy="6" r="2.4" fill="#e0d5bc" />
          </svg>
        </div>
        <Link to="/app" style={{ textDecoration: "none" }}>
          <div className="pm-banner-title">
            <span className="pm-title-cream">Profit Max: </span>
            <span className="pm-title-sand">Smart Pricing</span>
          </div>
        </Link>
      </div>

      <nav className="pm-banner-nav">
        {navLink("/app", "Home")}
        {navLink("/app/products", "Set Up Products")}
        {navLink("/app/analytics", "Analytics")}
        <Link to="/app/docs" className={pathname === "/app/docs" ? "pm-active" : ""}>Docs &amp; FAQ</Link>
      </nav>
    </div>
  );
}
