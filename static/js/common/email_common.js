// email_* 页面共享工具
// 目标：集中维护 API 地址、token 存取和 URL 参数读取，减少重复代码。
(function initEmailCommon(global) {
  // 后端 API 根地址。后续切换环境时统一在这里改。
  // const LITE_API = "http://127.0.0.1:8093";
  const LITE_API = "https://api.pusdc.xyz";
  const TOKEN_KEY = "pusdc_auth_token";

  // 统一 token 读写，避免各页面散落 localStorage 键名。
  function getAuthToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setAuthToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  // 读取单个查询参数。
  function getQueryParam(key) {
    const params = new URLSearchParams(window.location.search);
    return params.get(key);
  }

  // 按需读取多个参数；若缺少任意一个则返回 null。
  function getRequiredQueryParams(keys) {
    const params = new URLSearchParams(window.location.search);
    const result = {};
    for (const key of keys) {
      const value = params.get(key);
      if (!value) {
        return null;
      }
      result[key] = value;
    }
    return result;
  }

  global.PUSDCEmailCommon = Object.freeze({
    LITE_API,
    TOKEN_KEY,
    getAuthToken,
    setAuthToken,
    getQueryParam,
    getRequiredQueryParams,
  });
})(window);
