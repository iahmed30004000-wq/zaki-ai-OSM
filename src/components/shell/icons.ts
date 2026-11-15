import {
  RiAccountCircleFill, RiAccountCircleLine, RiAddCircleFill, RiAddCircleLine,
  RiAlertFill, RiAlertLine, RiArchiveDrawerFill, RiArchiveDrawerLine,
  RiArchiveFill, RiArchiveLine, RiArrowGoBackFill, RiArrowGoBackLine,
  RiArrowLeftRightFill, RiArrowLeftRightLine, RiAwardFill, RiAwardLine,
  RiBroadcastFill, RiBroadcastLine, RiBuilding4Fill, RiBuilding4Line,
  RiCalendarScheduleFill, RiCalendarScheduleLine, RiChat3Fill, RiChat3Line,
  RiClipboardFill, RiClipboardLine, RiDashboard3Fill, RiDashboard3Line,
  RiDiscountPercentFill, RiDiscountPercentLine, RiEarthFill, RiEarthLine,
  RiFileEditFill, RiFileEditLine, RiFileExcel2Fill, RiFileExcel2Line,
  RiFileList3Fill, RiFileList3Line, RiForbidFill, RiForbidLine,
  RiGitBranchFill, RiGitBranchLine, RiGroupFill, RiGroupLine,
  RiInboxArchiveFill, RiInboxArchiveLine, RiInboxFill, RiInboxLine,
  RiLayoutGridFill, RiLayoutGridLine, RiLayoutMasonryFill, RiLayoutMasonryLine,
  RiFlaskFill, RiFlaskLine,
  RiLayoutTopFill, RiLayoutTopLine, RiLightbulbFill, RiLightbulbLine,
  RiLineChartFill, RiLineChartLine,
  RiLockFill, RiLockLine, RiMapPinFill, RiMapPinLine,
  RiMegaphoneFill, RiMegaphoneLine, RiPercentFill, RiPercentLine,
  RiPrinterFill, RiPrinterLine, RiPriceTag3Fill, RiPriceTag3Line,
  RiRadarFill, RiRadarLine, RiRepeatFill, RiRepeatLine,
  RiRobot2Fill, RiRobot2Line, RiSendPlaneFill, RiSendPlaneLine,
  RiSettings3Fill, RiSettings3Line, RiShieldCheckFill, RiShieldCheckLine,
  RiShoppingCartFill, RiShoppingCartLine, RiShoppingBasket2Fill, RiShoppingBasket2Line, RiStackFill, RiStackLine,
  RiStore2Fill, RiStore2Line, RiTimerFill, RiTimerLine,
  RiTruckFill, RiTruckLine, RiUserSettingsFill, RiUserSettingsLine,
  RiWallet3Fill, RiWallet3Line,
  RiEBike2Fill, RiEBike2Line, RiSearchFill, RiSearchLine, RiFileTextFill, RiFileTextLine, RiGlobalFill, RiGlobalLine, RiLayoutFill, RiLayoutLine, RiPaletteFill, RiPaletteLine, RiShieldKeyholeFill, RiShieldKeyholeLine, RiSignpostFill, RiSignpostLine, RiTreeFill, RiTreeLine,
  RiShutDownFill, RiShutDownLine, RiSideBarFill, RiSideBarLine,
  RiStarFill, RiStarLine,
  type RemixiconComponentType,
} from '@remixicon/react';

/**
 * THE NAVIGATION'S ICONS — ONE FAMILY, AND TWO WEIGHTS.
 *
 * The route registry stores an icon as a NAME, because a route is data and
 * a component is not. This is the one place that turns a name into a glyph,
 * so it is also the one place that can hold the rule the whole product
 * follows: LINE at rest, FILL when the item is the one you are on.
 *
 * That pairing is the entire reason the family is Remix. A stroke-only set
 * has no filled twin, so "selected" has to be said with colour alone — and
 * colour alone is what a person misses when four items are the same shape
 * and one of them is slightly brighter.
 *
 * The names on the left are the registry's, unchanged: a route's data does
 * not know which icon library drew it this year.
 */
type Pair = { line: RemixiconComponentType; fill: RemixiconComponentType };

const pair = (line: RemixiconComponentType, fill: RemixiconComponentType): Pair => ({ line, fill });

export const ICONS: Record<string, Pair> = {
  AlertTriangle: pair(RiAlertLine, RiAlertFill),
  ArrowLeftRight: pair(RiArrowLeftRightLine, RiArrowLeftRightFill),
  BadgePercent: pair(RiDiscountPercentLine, RiDiscountPercentFill),
  Ban: pair(RiForbidLine, RiForbidFill),
  Blocks: pair(RiLayoutMasonryLine, RiLayoutMasonryFill),
  Bot: pair(RiRobot2Line, RiRobot2Fill),
  Boxes: pair(RiStackLine, RiStackFill),
  CalendarClock: pair(RiCalendarScheduleLine, RiCalendarScheduleFill),
  CircleUser: pair(RiAccountCircleLine, RiAccountCircleFill),
  ClipboardList: pair(RiClipboardLine, RiClipboardFill),
  Factory: pair(RiBuilding4Line, RiBuilding4Fill),
  FilePen: pair(RiFileEditLine, RiFileEditFill),
  FileSpreadsheet: pair(RiFileExcel2Line, RiFileExcel2Fill),
  FlaskConical: pair(RiFlaskLine, RiFlaskFill),
  Gauge: pair(RiDashboard3Line, RiDashboard3Fill),
  GitCompare: pair(RiGitBranchLine, RiGitBranchFill),
  Globe: pair(RiEarthLine, RiEarthFill),
  Inbox: pair(RiInboxLine, RiInboxFill),
  LayoutDashboard: pair(RiLayoutGridLine, RiLayoutGridFill),
  LayoutGrid: pair(RiLayoutGridLine, RiLayoutGridFill),
  Lightbulb: pair(RiLightbulbLine, RiLightbulbFill),
  Lock: pair(RiLockLine, RiLockFill),
  MapPin: pair(RiMapPinLine, RiMapPinFill),
  Megaphone: pair(RiMegaphoneLine, RiMegaphoneFill),
  MessageCircle: pair(RiChat3Line, RiChat3Fill),
  Package: pair(RiArchiveLine, RiArchiveFill),
  PackageCheck: pair(RiArchiveDrawerLine, RiArchiveDrawerFill),
  PackagePlus: pair(RiInboxArchiveLine, RiInboxArchiveFill),
  PanelsTopLeft: pair(RiLayoutTopLine, RiLayoutTopFill),
  Percent: pair(RiPercentLine, RiPercentFill),
  Printer: pair(RiPrinterLine, RiPrinterFill),
  Radar: pair(RiRadarLine, RiRadarFill),
  Receipt: pair(RiFileList3Line, RiFileList3Fill),
  Repeat: pair(RiRepeatLine, RiRepeatFill),
  ScrollText: pair(RiFileList3Line, RiFileList3Fill),
  Send: pair(RiSendPlaneLine, RiSendPlaneFill),
  Settings: pair(RiSettings3Line, RiSettings3Fill),
  ShieldCheck: pair(RiShieldCheckLine, RiShieldCheckFill),
  ShoppingCart: pair(RiShoppingCartLine, RiShoppingCartFill),
  // «السلات المهجورة»: a basket, so it is not read as a second «الطلبات» one line below it.
  CartAbandoned: pair(RiShoppingBasket2Line, RiShoppingBasket2Fill),
  Store: pair(RiStore2Line, RiStore2Fill),
  Tag: pair(RiPriceTag3Line, RiPriceTag3Fill),
  Timer: pair(RiTimerLine, RiTimerFill),
  // Growth is a rising line; a broadcast is a transmitter. They were
  // sharing one glyph, which makes two menu groups look like one thing.
  TrendingUp: pair(RiLineChartLine, RiLineChartFill),
  Truck: pair(RiTruckLine, RiTruckFill),
  Undo2: pair(RiArrowGoBackLine, RiArrowGoBackFill),
  UserCog: pair(RiUserSettingsLine, RiUserSettingsFill),
  Users: pair(RiGroupLine, RiGroupFill),
  Wallet: pair(RiWallet3Line, RiWallet3Fill),
  Award: pair(RiAwardLine, RiAwardFill),
  Plus: pair(RiAddCircleLine, RiAddCircleFill),
  // Nine routes were falling through to the archive box because
  // nobody had named them here — nine menu items wearing the
  // wrong glyph, which a fallback hides rather than reports.
  Bike: pair(RiEBike2Line, RiEBike2Fill),
  ShieldQuestion: pair(RiShieldKeyholeLine, RiShieldKeyholeFill),
  LayoutTemplate: pair(RiLayoutLine, RiLayoutFill),
  Palette: pair(RiPaletteLine, RiPaletteFill),
  ListTree: pair(RiTreeLine, RiTreeFill),
  // Not routes: the two chrome commands the palette offers. They live here
  // because there is one icon vocabulary, and a component that reaches past
  // it for a glyph is how a second family starts.
  SideBar: pair(RiSideBarLine, RiSideBarFill),
  SignOut: pair(RiShutDownLine, RiShutDownFill),
  FileText: pair(RiFileTextLine, RiFileTextFill),
  Languages: pair(RiGlobalLine, RiGlobalFill),
  Search: pair(RiSearchLine, RiSearchFill),
  Signpost: pair(RiSignpostLine, RiSignpostFill),
  Radio: pair(RiBroadcastLine, RiBroadcastFill),
  // «الآراء». A star, because a rating is stars everywhere a shopper has
  // ever seen one, and a menu item is not the place to be original.
  Star: pair(RiStarLine, RiStarFill),
};

/**
 * The glyph for a route. `active` decides the weight, and nothing else does —
 * a screen that wants a filled icon for another reason is a screen inventing
 * a second meaning for the same mark.
 *
 * An unknown name falls back to the archive box rather than to nothing: a
 * menu item with no icon reads as a broken build, and a route added without
 * touching this file is a mistake to see, not a crash.
 */
export function iconFor(name: string, active = false): RemixiconComponentType {
  const found = ICONS[name] ?? ICONS.Package;
  return active ? found.fill : found.line;
}
