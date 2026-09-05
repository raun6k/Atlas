export function Shell({
  title,
  fixture,
  merchantName,
  merchantDetail,
  children,
}: {
  title: string;
  fixture?: boolean;
  merchantName?: string;
  merchantDetail?: string;
  children: React.ReactNode;
}) {
  const name = merchantName || "QuickMart";
  return (
    <div className="shell">
      <a className="skip" href="#console-main">
        Skip to content
      </a>
      <header className="masthead">
        <div className="masthead-inner">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              A
            </span>
            <div className="brand-copy">
              <p className="brand">Atlas</p>
              <p className="brand-sub">{name}</p>
            </div>
          </div>
          <div className="mast-user">
            <span className="avatar">{name.charAt(0).toUpperCase()}</span>
            <div className="mast-user-copy">
              <p className="mast-name">{name}</p>
              <p className="mast-role">{merchantDetail || "Evidence console"}</p>
            </div>
          </div>
        </div>
      </header>
      <div className="main" id="console-main">
        <div className="main-inner wireframe">
          <header className="top">
            <div className="top-copy">
              <h1>{title}</h1>
              <p className="page-lead">Merchant details, confirmed orders, commerce strategies, and AtlasLab evaluation.</p>
            </div>
            {fixture ? (
              <div className="cluster">
                <span className="chip chip-fixture">Fixture data</span>
              </div>
            ) : null}
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}
