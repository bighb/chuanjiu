const BASE = import.meta.env.BASE_URL; // '/bbq/'

/** 站内路径拼接：url('ingredients/wuhua-rou') → '/bbq/ingredients/wuhua-rou' */
export const url = (path = '') => BASE.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
