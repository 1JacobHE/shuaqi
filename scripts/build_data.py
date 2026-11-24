# -*- coding: utf-8 -*-
"""构建 flytrip-finder 的本地基础数据：data/air.json + data/stations.json
数据来源：
  - Jonty/airline-route-data (airline_routes.json)：机场经纬度 + 真实航线 + 飞行时长/距离 + 承运航司
  - FlyClaw cache/airports.json：机场中文名 / 中文城市名
  - 12306 station_name.js：全国车站（按城市归并）
"""
"""
用法：
  python scripts/build_data.py                       # 原始数据默认放在 scripts/.src/
  python scripts/build_data.py --src D:/raw --out ../data

--src 目录需含两份**公开**数据集（自行下载，未随仓库分发）：
  airline_routes.json   Jonty/airline-route-data 的周更真实航线网络
                        （机场经纬度 + 真实航线 + 飞行时长/距离 + 承运航司）
  airports.json         FlyClaw 的机场库（机场中文名 / 中文城市名）

--out 目录需已存在 data/station_name.js（12306 公开的车站电报码表）。
输出：<out>/air.json（机场 + 航线 + 城市索引）与 <out>/stations.json（车站按城市归并）。
"""
import json, os, math, collections, argparse

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)
_ap = argparse.ArgumentParser()
_ap.add_argument('--src', default=os.path.join(_HERE, '.src'), help='原始数据目录')
_ap.add_argument('--out', default=os.path.join(ROOT, 'data'), help='输出数据目录')
_ap.add_argument('--stations', default='', help='12306 station_name.js 路径（默认取 <out>/station_name.js）')
_args = _ap.parse_args()
TMP = _args.src
OUT = _args.out
STATION_JS = _args.stations or os.path.join(OUT, 'station_name.js')

# ---------- 1. 载入航线库 ----------
jonty = json.load(open(os.path.join(TMP, 'airline_routes.json'), encoding='utf-8'))
fc = json.load(open(os.path.join(TMP, 'airports.json'), encoding='utf-8'))

# 航司 IATA -> 中文名（中国主要航司 + 常见外航）
AIRLINE_CN = {
    'CA': '中国国航', 'MU': '中国东航', 'CZ': '中国南航', 'HU': '海南航空', '3U': '四川航空',
    'ZH': '深圳航空', 'MF': '厦门航空', 'SC': '山东航空', '9C': '春秋航空', 'HO': '吉祥航空',
    'GS': '天津航空', 'KN': '中国联合航空', 'EU': '成都航空', 'GJ': '长龙航空', 'JD': '首都航空',
    'PN': '西部航空', '8L': '祥鹏航空', 'KY': '昆明航空', 'NS': '河北航空', 'RY': '江西航空',
    'TV': '西藏航空', 'G5': '华夏航空', 'CN': '大新华航空', 'DZ': '东海航空', 'Y8': '扬子江快运',
    'QW': '青岛航空', 'DR': '瑞丽航空', 'GT': '桂林航空', 'FU': '福州航空', 'GX': '北部湾航空',
    'A6': '湖南航空', 'QW': '青岛航空', 'JR': '幸福航空', 'BK': '奥凯航空', 'UQ': '乌鲁木齐航空',
}

# 地区合规化
def norm_region(country, iata):
    c = (country or '').strip()
    if iata in ('HKG',): return '中国香港'
    if iata in ('MFM',): return '中国澳门'
    if iata in ('TPE', 'TSA', 'KHH', 'RMQ', 'TNN', 'HUN', 'MZG', 'KNH', 'LZN', 'TTT', 'CYI', 'PIF', 'GNI', 'WOT'):
        return '中国台湾'
    if c in ('China', 'CN', 'China '): return '中国'
    if c in ('Hong Kong SAR', 'Hong Kong'): return '中国香港'
    if c in ('Macau SAR', 'Macau', 'Macao'): return '中国澳门'
    if c in ('Taiwan',): return '中国台湾'
    return c

ports = {}
for iata, v in jonty.items():
    try:
        lat = float(v.get('latitude')); lon = float(v.get('longitude'))
    except Exception:
        continue
    cn_info = fc.get(iata) or {}
    name_cn = cn_info.get('name_cn') or v.get('name') or iata
    city_cn = cn_info.get('city_cn')
    if not city_cn:
        # 用英文城市名的中文映射兜底（暂无则用英文）
        city_cn = None
    ports[iata] = {
        'iata': iata,
        'cn': name_cn,
        'city': city_cn,
        'city_en': v.get('city_name') or '',
        'region': norm_region(v.get('country'), iata),
        'lat': round(lat, 4),
        'lon': round(lon, 4),
    }

# 补中文城市名（Jonty 城市英文 -> FlyClaw 中文），按 IATA 关联
CITY_CN_FIX = {
    'Beijing': '北京', 'Shanghai': '上海', 'Guangzhou': '广州', 'Shenzhen': '深圳',
    'Chengdu': '成都', 'Chongqing': '重庆', 'Hangzhou': '杭州', 'Nanjing': '南京',
    'Wuhan': '武汉', "Xi'an": '西安', 'Tianjin': '天津', 'Zhengzhou': '郑州',
    'Changsha': '长沙', 'Hefei': '合肥', 'Jinan': '济南', 'Qingdao': '青岛',
    'Fuzhou': '福州', 'Xiamen': '厦门', 'Nanchang': '南昌', 'Kunming': '昆明',
    'Guiyang': '贵阳', 'Nanning': '南宁', 'Taiyuan': '太原', 'Shijiazhuang': '石家庄',
    'Shenyang': '沈阳', 'Harbin': '哈尔滨', 'Changchun': '长春', 'Dalian': '大连',
    'Lanzhou': '兰州', 'Xining': '西宁', 'Yinchuan': '银川', 'Urumqi': '乌鲁木齐',
    'Hohhot': '呼和浩特', 'Haikou': '海口', 'Sanya': '三亚', 'Wuxi': '无锡',
    'Changzhou': '常州', 'Ningbo': '宁波', 'Wenzhou': '温州', 'Xuzhou': '徐州',
    'Foshan': '佛山', 'Dongguan': '东莞', 'Zhuhai': '珠海', 'Quanzhou': '泉州',
    'Nantong': '南通', 'Yangzhou': '扬州', 'Shaoxing': '绍兴', 'Jiaxing': '嘉兴',
    'Huzhou': '湖州', 'Taizhou': '台州', 'Jinhua': '金华', 'Yantai': '烟台',
    'Weifang': '潍坊', 'Luoyang': '洛阳', 'Baoding': '保定', 'Tangshan': '唐山',
    'Lijiang': '丽江', 'Dali City': '大理', 'Dayong': '张家界', 'Guilin': '桂林',
    'Nanning': '南宁', 'Yiwu': '义乌', 'Wuyishan': '武夷山', 'Huangshan': '黄山',
    'Dunhuang': '敦煌', 'Xishuangbanna': '西双版纳', 'Lhasa': '拉萨', 'Jiuquan': '酒泉',
    'Hong Kong': '中国香港', 'Macau': '中国澳门', 'Taipei': '中国台湾', 'Kaohsiung': '中国台湾',
    'Kashgar': '喀什', 'Hotan': '和田', 'Aksu': '阿克苏', 'Yining': '伊宁', 'Karamay': '克拉玛依',
    'Baotou': '包头', 'Ordos': '鄂尔多斯', 'Hailar': '呼伦贝尔', 'Chifeng': '赤峰',
    'Mudanjiang': '牡丹江', 'Jiamusi': '佳木斯', 'Qiqihar': '齐齐哈尔', 'Yanji': '延吉',
    'Dandong': '丹东', 'Jinzhou': '锦州', 'Anshan': '鞍山', 'Yingkou': '营口',
    'Weihai': '威海', 'Linyi': '临沂', 'Jining': '济宁', 'Dongying': '东营',
    'Nanyang': '南阳', 'Xiangyang': '襄阳', 'Yichang': '宜昌', 'Enshi': '恩施',
    'Changde': '常德', 'Hengyang': '衡阳', 'Chenzhou': '郴州', 'Huaihua': '怀化',
    'Yancheng': '盐城', 'Huai\'an': '淮安', 'Lianyungang': '连云港', 'Zhenjiang': '镇江',
    'Taizhou': '台州', 'Quzhou': '衢州', 'Zhoushan': '舟山', 'Huangyan': '台州',
    'Ganzhou': '赣州', 'Jingdezhen': '景德镇', 'Jiujiang': '九江', 'Yichun': '宜春',
    'Shangrao': '上饶', 'Jinggangshan': '吉安', 'Mianyang': '绵阳', 'Nanchong': '南充',
    'Yibin': '宜宾', 'Luzhou': '泸州', 'Dazhou': '达州', 'Xichang': '西昌',
    'Panzhihua': '攀枝花', 'Zunyi': '遵义', 'Anshun': '安顺', 'Kaili': '凯里',
    'Tongren': '铜仁', 'Lipingshan': '黎平', 'Xingyi': '兴义', 'Baoshan': '保山',
    'Tengchong': '腾冲', 'Lincang': '临沧', 'Pu\'er': '普洱', 'Wenshan': '文山',
    'Zhaotong': '昭通', 'Diqing': '香格里拉', 'Shangri-La': '香格里拉',
    'Yan\'an': '延安', 'Yulin': '榆林', 'Hanzhong': '汉中', 'Ankang': '安康',
    'Golmud': '格尔木', 'Yushu': '玉树', 'Delingha': '德令哈', 'Zhangye': '张掖',
    'Jiayuguan': '嘉峪关', 'Qingyang': '庆阳', 'Tianshui': '天水', 'Longnan': '陇南',
    'Guyuan': '固原', 'Zhongwei': '中卫', 'Alxa Left Banner': '阿拉善',
    'Erenhot': '二连浩特', 'Manzhouli': '满洲里', 'Ulanhot': '乌兰浩特',
    'Tongliao': '通辽', 'Xilinhot': '锡林浩特', 'Wulanchabu': '乌兰察布',
    'Datong': '大同', 'Changzhi': '长治', 'Linfen': '临汾', 'Xinzhou': '忻州',
    'Yuncheng': '运城', 'Luliang': '吕梁', 'Handan': '邯郸', 'Qinhuangdao': '秦皇岛',
    'Cangzhou': '沧州', 'Zhangjiakou': '张家口', 'Chengde': '承德',
    'Xingtai': '邢台', 'Tangshan': '唐山', 'Weihai': '威海',
    'Nyingchi': '林芝', 'Shigatse': '日喀则', 'Qamdo': '昌都', 'Ngari': '阿里',
    'Xiamen': '厦门', 'Wuyishan': '武夷山', 'Quanzhou': '泉州', 'Liancheng': '龙岩',
    'Sanming': '三明', 'Fuzhou': '福州', 'Jingdezhen': '景德镇',
    'Zhuhai': '珠海', 'Jieyang': '揭阳', 'Meizhou': '梅州', 'Zhanjiang': '湛江',
    'Shantou': '汕头', 'Huizhou': '惠州', 'Shaoguan': '韶关', 'Wuzhou': '梧州',
    'Beihai': '北海', 'Baise': '百色', 'Liuzhou': '柳州', 'Guilin': '桂林',
    'Yulin': '玉林', 'Hechi': '河池', 'Qionghai': '琼海', 'Wuzhishan': '五指山',
    # 第二批：Jonty 数据里 FlyClaw 未覆盖的中文城市名
    'An Yang': '安阳', 'Baicheng': '白城', 'Bengbu': '蚌埠', 'Biancheng': '边城',
    'Bozhou': '亳州', 'Buerjin': '布尔津', 'Cangyuan': '沧源', 'Chizhou': '池州',
    'Fuyuan County': '抚远', 'Fuyun': '富蕴', 'Golog': '果洛', 'Hami': '哈密',
    'Hejing': '和静', 'Heze': '菏泽', 'Hongping': '红坪', 'Huatugou': '花土沟',
    'Jiagedaqi District': '加格达奇', 'Jiansanjiang': '建三江', 'Kangding': '康定',
    'Lancang': '澜沧', 'Lishui': '丽水', 'Luntai': '轮台', 'Ninglang': '宁蒗',
    'Qiaoli': '且末', 'Qitai': '奇台', 'Rizhao': '日照', 'Ruijin': '瑞金',
    'Shache': '莎车', 'Shannan': '山南', 'Shaoyang': '邵阳', 'Shekou': '蛇口',
    'Shihezi': '石河子', 'Shiyan': '十堰', 'Suifenhe': '绥芬河', 'Wudalianchi': '五大连池',
    'Xiahe': '夏河', 'Xinyuan': '新源', 'Nyingchi': '林芝', 'Hongyuan': '红原',
    'Daocheng': '稻城', 'Ganzi': '甘孜', 'Yushu': '玉树', 'Golmud': '格尔木',
    'Delingha': '德令哈', 'Altay': '阿勒泰', 'Tacheng': '塔城', 'Korla': '库尔勒',
    'Kuqa': '库车', 'Aksu': '阿克苏', 'Hotan': '和田', 'Yarkant': '莎车',
    'Burqin': '布尔津', 'Karamay': '克拉玛依', 'Yining': '伊宁', 'Tumxuk': '图木舒克',
    'Bole': '博乐', 'Alar': '阿拉尔', 'Tiemenguan': '铁门关', 'Kunyu': '昆玉',
    'Hoboksar': '和布克赛尔', 'Fuyun County': '富蕴', 'Tuokexun': '托克逊',
    'Zhangye': '张掖', 'Jiayuguan': '嘉峪关', 'Dunhuang': '敦煌', 'Jinchang': '金昌',
    'Qingyang': '庆阳', 'Tianshui': '天水', 'Longnan': '陇南', 'Gannan': '甘南',
    'Chizhou Jiuhuashan': '池州', 'Anqing': '安庆', 'Fuyang': '阜阳', 'Lu\'an': '六安',
    'Chuzhou': '滁州', 'Xuancheng': '宣城', 'Huangshan City': '黄山', 'Jixi': '绩溪',
}
for iata, p in ports.items():
    if not p['city']:
        p['city'] = CITY_CN_FIX.get(p['city_en'], p['city_en'])
    if p['iata'] == 'HKG': p['city'] = '中国香港'
    if p['iata'] == 'MFM': p['city'] = '中国澳门'
    if p['region'] == '中国台湾': p['city'] = '中国台湾'

# 机场中文名订正：FlyClaw 中文库未收录的新机场会落到英文名，
# 这里用官方中文名补齐（否则界面上会出现「Jiaxing Nanhu Airport」这种夹杂）
PORT_CN_FIX = {
    'WUX': '苏南硕放国际机场', 'JNH': '嘉兴南湖机场', 'NTG': '南通兴东机场',
    'BFY': '蚌埠滕湖机场', 'BPE': '秦皇岛北戴河机场', 'BZJ': '亳州机场',
    'CWJ': '沧源佤山机场', 'DBC': '白城长安机场', 'DHH': '巴里坤大河机场',
    'DTU': '德都机场', 'DXJ': '湘西边城机场', 'FYJ': '抚远机场',
    'FYN': '富蕴可可托海机场', 'GMQ': '果洛玛沁机场', 'GXH': '甘南夏河机场',
    'HHP': '上环直升机坪', 'HJB': '和静巴音布鲁克机场', 'HPG': '神农架机场',
    'HQQ': '安阳红旗渠机场', 'HSF': '绥芬河东宁机场', 'HTT': '花土沟机场',
    'HZA': '菏泽牡丹机场', 'JBK': '江布拉克机场', 'JGD': '加格达奇机场',
    'JMJ': '景迈机场', 'JRJ': '赣州瑞金机场', 'JSJ': '建三江机场',
    'JUH': '池州九华山机场', 'KGT': '康定机场', 'KJI': '喀纳斯机场',
    'LFQ': '临汾乔李机场', 'LGZ': '山南隆子机场', 'LIJ': '丽水机场',
    'LLV': '吕梁机场', 'LTJ': '轮台机场', 'NLH': '宁蒗泸沽湖机场',
    'NLT': '那拉提机场', 'QSZ': '莎车机场', 'RIZ': '日照山字河机场',
    'RKZ': '日喀则和平机场', 'SHF': '石河子花园机场', 'WDS': '十堰武当山机场',
    'WGN': '武冈机场', 'WNH': '文山机场', 'WUT': '五台山机场',
    'XNT': '邢台机场', 'XZM': '澳门外港码头', 'YIC': '宜春明月山机场',
    'YTY': '扬州泰州机场', 'ZGC': '中川机场', 'ZQZ': '张家口宁远机场',
    'ZYK': '蛇口码头',
}
for iata, cn in PORT_CN_FIX.items():
    if iata in ports:
        ports[iata]['cn'] = cn

# ---------- 2. 航线（保留两端都在中国境内的）----------
routes = collections.defaultdict(list)
for iata, v in jonty.items():
    if iata not in ports: continue
    for r in v.get('routes', []):
        to = r.get('iata')
        if to not in ports: continue
        if ports[iata]['region'] != '中国' or ports[to]['region'] != '中国':
            continue  # 只保留中国大陆境内航线（时间圈主要场景）
        by = []
        for c in (r.get('carriers') or []):
            ci = c.get('iata') or ''
            by.append(AIRLINE_CN.get(ci, c.get('name') or ci))
        # 去重保序
        seen = set(); by2 = []
        for x in by:
            if x and x not in seen: seen.add(x); by2.append(x)
        routes[iata].append({
            'to': to,
            'km': r.get('km'),
            'min': r.get('min'),
            'by': by2[:3],
        })

# 只保留有航线的机场
routes = {k: v for k, v in routes.items() if v}

# ---------- 3. 城市 -> 机场（含邻近机场）----------
by_city = collections.defaultdict(list)
for p in ports.values():
    if p['region'] == '中国' and p['city']:
        by_city[p['city']].append(p['iata'])

def dist_km(a, b):
    R = 6371.0
    la1, lo1, la2, lo2 = map(math.radians, [a['lat'], a['lon'], b['lat'], b['lon']])
    h = math.sin((la2-la1)/2)**2 + math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))

# 城市坐标：有机场的城市取其机场坐标；极少数无民航机场的重要城市（苏州/东莞）手工标注
CITY_COORD_EXTRA = {
    '苏州': (31.30, 120.62),   # 苏州无民航机场，实际用无锡硕放 / 上海虹桥 / 浦东
    '东莞': (23.02, 113.75),
    '昆山': (31.39, 120.98),
    '常熟': (31.65, 120.75),
    '张家港': (31.87, 120.55),
    '太仓': (31.45, 121.10),
}
PORT_LIST = [p for p in ports.values() if p['region'] == '中国' and p['iata'] in routes]
city_ports = {}
all_cities = set(by_city.keys()) | set(CITY_COORD_EXTRA.keys())
for city in sorted(all_cities):
    iatas = by_city.get(city, [])
    own = [i for i in iatas if i in routes]
    if own:
        base = ports[own[0]]
    elif city in CITY_COORD_EXTRA:
        la, lo = CITY_COORD_EXTRA[city]
        base = {'lat': la, 'lon': lo}
    else:
        continue
    near = []
    for p in PORT_LIST:
        if p['city'] == city: continue
        d = dist_km(base, p)
        if d <= 160:
            near.append((round(d), p['iata'], p['city']))
    near.sort()
    # 同一城市最多保留 2 个机场（如上海=虹桥+浦东），保证"上海"两个都能被选到
    seen_city = collections.Counter(); near2 = []
    for d, i, c in near:
        if seen_city[c] >= 2: continue
        seen_city[c] += 1; near2.append({'iata': i, 'city': c, 'km': d})
    # 保留上限 10：早期取 5 会把浦东(PVG)、萧山(HGH) 这类稍远但极关键的大枢纽砍掉，
    # 实测苏州的航班可达目的地会因此从 87 个掉到 41 个 —— 得不偿失。
    city_ports[city] = {'own': own, 'near': near2[:10]}

# ---------- 4. 车站（12306）----------
raw = open(STATION_JS, encoding='utf-8').read()
body = raw[raw.index('=')+2: raw.rfind("'")]
st_by_city = collections.defaultdict(list)
for r in body.split('@'):
    if not r: continue
    f = r.split('|')
    if len(f) < 8: continue
    name, city = f[1], f[7]
    if not city or not name: continue
    st_by_city[city].append(name)

DIR_ORDER = {'北': 1, '东': 2, '南': 3, '西': 4}

# 主要出发城市的"常用车站"白名单（按重要性排序）——勾选界面里优先展示这几个
STATION_WHITELIST = {
    '苏州': ['苏州', '苏州北', '苏州园区', '苏州新区', '苏州南', '昆山南', '张家港', '常熟', '太仓', '太仓南'],
    '上海': ['上海虹桥', '上海', '上海南', '上海西'],
    '无锡': ['无锡', '无锡东', '无锡新区', '惠山'],
    '南京': ['南京南', '南京'],
    '杭州': ['杭州东', '杭州', '杭州西', '杭州南'],
    '北京': ['北京南', '北京', '北京西', '北京北', '北京丰台', '北京朝阳', '北京大兴', '清河'],
    '广州': ['广州南', '广州', '广州东', '广州北'],
    '深圳': ['深圳北', '深圳', '深圳东', '福田', '深圳坪山'],
    '成都': ['成都东', '成都', '成都南', '成都西'],
    '重庆': ['重庆北', '重庆西', '重庆', '沙坪坝'],
    '武汉': ['武汉', '汉口', '武昌', '武汉东'],
    '西安': ['西安北', '西安', '西安南'],
    '天津': ['天津', '天津西', '天津南', '滨海'],
    '郑州': ['郑州东', '郑州', '郑州西', '航空港'],
    '长沙': ['长沙南', '长沙', '长沙西'],
    '合肥': ['合肥南', '合肥', '合肥北城'],
    '济南': ['济南西', '济南', '济南东', '大明湖'],
    '青岛': ['青岛北', '青岛', '青岛西', '红岛'],
    '福州': ['福州', '福州南'],
    '厦门': ['厦门北', '厦门', '厦门高崎'],
    '南昌': ['南昌西', '南昌', '南昌东'],
    '昆明': ['昆明南', '昆明'],
    '贵阳': ['贵阳北', '贵阳', '贵阳东'],
    '南宁': ['南宁东', '南宁'],
    '太原': ['太原南', '太原'],
    '石家庄': ['石家庄', '石家庄北', '石家庄东'],
    '沈阳': ['沈阳北', '沈阳', '沈阳南'],
    '哈尔滨': ['哈尔滨西', '哈尔滨', '哈尔滨东', '哈尔滨北'],
    '长春': ['长春', '长春西'],
    '大连': ['大连北', '大连'],
    '兰州': ['兰州西', '兰州'],
    '西宁': ['西宁'],
    '银川': ['银川'],
    '乌鲁木齐': ['乌鲁木齐', '乌鲁木齐南'],
    '呼和浩特': ['呼和浩特东', '呼和浩特'],
    '海口': ['海口东', '海口'],
    '三亚': ['三亚'],
    '宁波': ['宁波', '宁波东'],
    '温州': ['温州南', '温州'],
    '徐州': ['徐州东', '徐州'],
    '常州': ['常州', '常州北'],
    '南通': ['南通', '南通西'],
    '扬州': ['扬州', '扬州东'],
    '绍兴': ['绍兴北', '绍兴'],
    '嘉兴': ['嘉兴南', '嘉兴'],
    '湖州': ['湖州', '湖州东'],
    '台州': ['台州西', '台州'],
    '金华': ['金华', '金华南'],
    '烟台': ['烟台', '烟台南'],
    '潍坊': ['潍坊', '潍坊北'],
    '洛阳': ['洛阳龙门', '洛阳'],
}

def station_rank(city, name):
    """越小越靠前：白名单 > 同名主站 > 方位站(北>东>南>西) > 其它含城名站 > 外埠站

    末位一律附上 name 作为**确定性**兜底：否则同分项会按 set 的迭代顺序排列，
    而 Python 对字符串的哈希是逐进程随机化的 —— 同一个脚本两次跑出来的车站顺序会不一样。
    """
    if name == city: return (1, 0, len(name), name)
    wl = STATION_WHITELIST.get(city)
    if wl and name in wl:
        return (0, wl.index(name), len(name), name)
    if name.startswith(city):
        rest = name[len(city):]
        if len(rest) == 1 and rest in DIR_ORDER:
            return (2, DIR_ORDER[rest], len(name), name)
        return (3, 5, len(name), name)
    if city in name: return (3, 6, len(name), name)
    return (4, 9, len(name), name)

stations = {}
for city, arr in st_by_city.items():
    uniq = sorted(set(arr), key=lambda n: station_rank(city, n))
    stations[city] = uniq

# ---------- 5. 输出 ----------
# 只保留中国地区（含港澳台）机场，避免输出全球 4000+ 机场导致文件臃肿
CN_REGION = ('中国', '中国香港', '中国澳门', '中国台湾')
ports_cn = {k: v for k, v in ports.items() if v['region'] in CN_REGION}
# 未匹配到中文名的，标记出来
english_left = sorted({v['city'] for v in ports_cn.values() if v['city'] and not any('\u4e00' <= ch <= '\u9fff' for ch in v['city'])})
if english_left:
    print('⚠ 仍为英文城市名（未匹配）:', english_left[:20], '... 共', len(english_left))

air = {
    '_note': '机场与航线数据：Jonty/airline-route-data（周更）+ FlyClaw airports.json（中文名）。港澳台按中国地区标注；仅保留中国大陆境内直飞航线。',
    'ports': ports_cn,
    'cities': city_ports,
    'routes': routes,
}
json.dump(air, open(os.path.join(OUT, 'air.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
json.dump({'_note': '12306 车站按城市归并（来源 station_name.js）', 'cities': stations},
          open(os.path.join(OUT, 'stations.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

print('端口数', len(ports), '| 有航线机场', len(routes), '| 航线总条数', sum(len(v) for v in routes.values()))
print('城市(有航线)', sum(1 for v in city_ports.values() if v['own']), '| 城市(含邻近)', len(city_ports))
print('车站城市数', len(stations))
for c in ['苏州', '上海', '无锡', '南京', '北京', '成都']:
    print(f'  {c}: 机场={city_ports.get(c)}')
    print(f'     车站前6={stations.get(c, [])[:6]}')
print('air.json', os.path.getsize(os.path.join(OUT, 'air.json'))//1024, 'KB')
print('stations.json', os.path.getsize(os.path.join(OUT, 'stations.json'))//1024, 'KB')
