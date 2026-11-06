// The top bar: brand and clock, plan and Mac pills, replay, settings, night switch.
// Static markup: the office's code (src/office) finds these elements by id and fills them in.
import SettingsPanel from './SettingsPanel';
import Image from 'next/image';
import { getT } from '@/i18n/server';

export default async function TopBar() {
  const t = await getT();
  return (
    <header className="topbar">
      <div className="tb-brand"><span className="logo" role="img" aria-label="LioOps">
        <Image className="logo-wordmark" src={`${process.env.NEXT_PUBLIC_BASE_PATH || ''}/assets/branding/logo-wordmark-dark.svg`} alt="" width={960} height={274} unoptimized loading="eager" />
        <Image className="logo-mark" src={`${process.env.NEXT_PUBLIC_BASE_PATH || ''}/assets/branding/logo-mark.png`} alt="" width={192} height={192} unoptimized loading="eager" />
      </span><span className="tb-clock" id="clock">--:--</span><span className="demo-chip" id="demo-chip" hidden>DEMO<span className="demo-more"> · {t('ui.topBar.sampleData')}</span></span><span className="demo-chip replay-chip" id="replay-chip" hidden></span></div>
      <div className="tb-actions">
        <div className="pop-wrap">
          <button id="btn-codex-usage" className="tb-btn mac-pill codex-pill" type="button" hidden aria-expanded="false" aria-controls="pop-codex-usage" aria-label={t('chat.codex.quotaTitle')}>
            <i className="lvl"></i><span className="mp-label">Codex</span><span className="mp-val" id="codex-quota-mini">–</span><span className="mp-bar"><b id="codex-quota-bar"></b></span>
          </button>
          <div className="pop pop-plan" id="pop-codex-usage" hidden role="dialog" aria-label={t('chat.codex.quotaTitle')}>
            <div className="codex-quota-head"><b>{t('chat.codex.quotaTitle')}</b><button id="codex-quota-close" className="icon-btn" type="button" aria-label={t('common.close')}>×</button></div>
            <small id="codex-quota-at"></small>
            <div id="codex-quota-rows"></div>
            <p id="codex-quota-empty" className="muted">{t('chat.codex.limitsUnavailable')}</p>
            <p id="codex-quota-error" className="muted" hidden>{t('chat.codex.quotaRefreshFailed')}</p>
            <p className="plan-foot">{t('chat.codex.quotaNote')}</p>
          </div>
        </div>
        <div className="pop-wrap">
          <button id="btn-plan" className="tb-btn mac-pill plan-pill" type="button" data-level="normal" aria-expanded="false" aria-controls="pop-plan" hidden><i className="lvl"></i><span className="mp-label">{t('ui.topBar.plan')}</span><span className="mp-val" id="plan-mini">{t('ui.topBar.reading')}</span><span className="mp-bar"><b id="plan-bar"></b></span></button>
          <div className="pop pop-plan" id="pop-plan" hidden role="dialog" aria-label={t('ui.topBar.planLimits')}>
            <div className="plan-card" id="plan-card">
              <span className="hl-head"><b>{t('ui.topBar.planLimits')}</b><span className="pl-at" id="plan-at"></span></span>
              <span className="plan-acct" id="plan-acct" hidden></span>
              <div className="plan-rows" id="plan-rows"></div>
              <div className="plan-add" id="plan-add"></div>
              <p className="plan-empty" id="plan-empty">{t('ui.topBar.planEmpty')}</p>
              <button className="plan-burn" id="plan-burn" type="button" hidden></button>
              <p className="plan-foot">{t('ui.topBar.planFoot')}</p>
            </div>
          </div>
        </div>
        <button id="btn-mac" className="tb-btn mac-pill" type="button" data-level="normal" title={t('ui.topBar.macTitle')}><i className="lvl"></i><span className="mp-label">{t('ui.topBar.mac')}</span><span className="mp-val" id="mac-mini">{t('ui.topBar.measuring')}</span><span className="mp-bar"><b id="ml-ram"></b></span><i className="mp-tip" id="mac-tip" hidden></i></button>
        <button id="btn-give-work" className="tb-btn" type="button" hidden aria-pressed="false" title={t('workspace.title')} aria-label={t('workspace.title')}><span data-icon="clipboard"></span><span className="lbl">{t('workspace.title')}</span></button>
        <button id="btn-chat" className="tb-btn tb-chat" type="button" aria-pressed="false" title={t('chat.openTitle')}><span data-icon="chat"></span><span className="lbl">{t('chat.open')}</span><i className="tb-badge" id="chat-badge" hidden></i></button>
        <button id="btn-replay" className="tb-btn" type="button" aria-pressed="false" title={t('ui.topBar.replayTitle')}><span data-icon="rewind"></span><span className="lbl">{t('ui.topBar.replay')}</span></button>
        <div className="pop-wrap">
          <button id="btn-look" className="tb-btn" type="button" aria-expanded="false" aria-controls="pop-look" title={t('ui.topBar.settingsTitle')}><span data-icon="gear"></span><span className="lbl">{t('ui.topBar.settings')}</span></button>
          <SettingsPanel />
        </div>
        <button id="btn-phone-top" className="tb-btn tb-icon" type="button" hidden aria-label={t('ui.topBar.phone')} title={t('ui.topBar.phoneTitle')}><span data-icon="phone"></span></button>
        <button id="btn-night" className="tb-btn tb-icon" type="button" aria-pressed="false" aria-label={t('ui.topBar.nightLabel')} title={t('ui.topBar.nightTitle')}><span data-icon="moon"></span></button>
      </div>
    </header>
  );
}
