// 主题切换功能
export function initThemeSwitcher() {
  const themeToggle = document.createElement('button');
  themeToggle.id = 'themeToggle';
  themeToggle.innerHTML = '🌙';
  themeToggle.style.position = 'fixed';
  themeToggle.style.bottom = '20px';
  themeToggle.style.right = '20px';
  themeToggle.style.zIndex = '1000';
  themeToggle.style.background = 'var(--primary-color)';
  themeToggle.style.color = 'white';
  themeToggle.style.border = 'none';
  themeToggle.style.borderRadius = '50%';
  themeToggle.style.width = '50px';
  themeToggle.style.height = '50px';
  themeToggle.style.fontSize = '1.5rem';
  themeToggle.style.cursor = 'pointer';
  themeToggle.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
  
  document.body.appendChild(themeToggle);

  themeToggle.addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    themeToggle.innerHTML = isDark ? '🌙' : '☀️';
    
    // 保存用户偏好
    try {
      localStorage.setItem('themePreference', isDark ? 'light' : 'dark');
    } catch (e) {
      console.warn('无法访问localStorage:', e);
    }
  });

  // 初始化主题
  try {
    const savedTheme = localStorage.getItem('themePreference') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    themeToggle.innerHTML = savedTheme === 'dark' ? '☀️' : '🌙';
  } catch (e) {
    console.warn('无法读取localStorage:', e);
    document.documentElement.setAttribute('data-theme', 'light');
  }
}