// 主题切换功能
export function initThemeSwitcher() {
  // Get the theme toggle button from the HTML (added in index.html)
  const themeToggleBtn = document.getElementById('themeToggleBtn');

  if (!themeToggleBtn) {
    console.error('Theme toggle button #themeToggleBtn not found in HTML.');
    return; // Exit if the button doesn't exist
  }

  // Define SVG icons for light/dark mode for consistency with other buttons
  const moonIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-moon"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
  const sunIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-sun"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;

  // Remove inline styles previously applied to the dynamic button
  // themeToggleBtn.style = ''; // Or remove specific style properties if needed

  themeToggleBtn.addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    themeToggleBtn.innerHTML = isDark ? moonIcon : sunIcon; // Use SVG icons

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
    themeToggleBtn.innerHTML = savedTheme === 'dark' ? sunIcon : moonIcon; // Set initial icon
  } catch (e) {
    console.warn('无法读取localStorage:', e);
    // Set default icon if storage fails
    themeToggleBtn.innerHTML = moonIcon;
    document.documentElement.setAttribute('data-theme', 'light');
  }
}