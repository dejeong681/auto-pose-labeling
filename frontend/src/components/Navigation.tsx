const navigationItems = [
  { href: '/labeling', label: '포즈 라벨링' },
  { href: '/classifier', label: '클래스 필터링' },
];

export default function Navigation() {
  const currentPath = window.location.pathname;

  return (
    <nav className="app-navigation" aria-label="주 메뉴">
      {navigationItems.map((item) => (
        <a key={item.href} href={item.href} className={currentPath === item.href ? 'active' : ''}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}
