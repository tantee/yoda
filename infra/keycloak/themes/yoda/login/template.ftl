<#import "footer.ftl" as loginFooter>
<#--
  Yoda login layout: a navy brand panel (mark, product name, tagline) and a white card with the form.
  Every login page (sign in, password reset, OTP, errors, ...) renders inside this macro; the sections
  ("header", "show-username", "form", "socialProviders", "info") are the ones Keycloak's base pages fill.
  Hooks kept on purpose for later additions:
  - .yoda-brand__sky: an empty decorative layer behind the brand panel (aria-hidden).
  - #yoda-tagline: one line of copy under the product name (message key yodaTagline).
  - body classes come from properties.kcBodyClass, so a theme property can add a modifier class.
  Fun touches (docs/design/jedi-touch.md): when the theme property funMode is "true" the body gets yoda-fun
  (starfield in .yoda-brand__sky), the mark is mark-fun.svg and one playful line (yodaWisdom) follows the tagline.
-->
<#assign yodaFun = (properties.funMode!'false')?trim == 'true'>
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}" lang="${(locale.currentLanguageTag)!'en'}" dir="${((locale.rtl)!false)?then('rtl','ltr')}">

<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="robots" content="noindex, nofollow">
    <#if properties.meta?has_content>
        <#list properties.meta?split(' ') as meta>
            <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
        </#list>
    </#if>
    <meta name="color-scheme" content="light">
    <title>${msg("yodaPageTitle")}</title>
    <link rel="icon" type="image/svg+xml" href="${url.resourcesPath}/img/favicon.svg" />
    <link rel="preload" href="${url.resourcesPath}/fonts/ibm-plex-sans-thai-thai-400-normal.woff2" as="font" type="font/woff2" crossorigin />
    <#if properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="importmap">
        {
            "imports": {
                "rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js"
            }
        }
    </script>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="module">
        import { startSessionPolling } from "${url.resourcesPath}/js/authChecker.js";

        startSessionPolling(
          "${url.ssoLoginInOtherTabsUrl?no_esc}"
        );
    </script>
</head>

<body class="${properties.kcBodyClass!}<#if yodaFun> yoda-fun</#if><#if bodyClass?has_content> ${bodyClass}</#if>">
<div class="${properties.kcLoginClass!}">
    <header id="kc-header" class="${properties.kcHeaderClass!}">
        <div class="yoda-brand__sky" aria-hidden="true"></div>
        <div id="kc-header-wrapper" class="${properties.kcHeaderWrapperClass!}">
            <img class="yoda-mark" src="${url.resourcesPath}/img/<#if yodaFun>mark-fun<#else>mark</#if>.svg" alt="" width="40" height="40" />
            <div class="yoda-brand__text">
                <p class="yoda-brand__name">${msg("yodaProductName")}</p>
                <p class="yoda-brand__sub">${msg("yodaProductSub")}</p>
            </div>
        </div>
        <p id="yoda-tagline" class="yoda-brand__tagline">${msg("yodaTagline")}</p>
        <#if yodaFun><p id="yoda-wisdom" class="yoda-brand__wisdom">${msg("yodaWisdom")}</p></#if>
    </header>

    <main class="yoda-main">
      <div class="${properties.kcFormCardClass!}">
        <header class="${properties.kcFormHeaderClass!}">
            <#if realm.internationalizationEnabled && locale.supported?size gt 1>
                <nav id="kc-locale" class="${properties.kcLocaleMainClass!}" aria-label="${msg("languages")}">
                    <ul class="${properties.kcLocaleListClass!}">
                        <#list locale.supported as l>
                            <li class="${properties.kcLocaleListItemClass!}">
                                <a class="${properties.kcLocaleItemClass!}" href="${l.url}" lang="${l.languageTag}"<#if l.languageTag == locale.currentLanguageTag> aria-current="true"</#if>>${l.label}</a>
                            </li>
                        </#list>
                    </ul>
                </nav>
            </#if>
            <#if displayRequiredFields>
                <p class="yoda-required"><span class="required" aria-hidden="true">*</span> ${msg("requiredFields")}</p>
            </#if>
            <#if !(auth?has_content && auth.showUsername() && !auth.showResetCredentials())>
                <h1 id="kc-page-title"><#nested "header"></h1>
            <#else>
                <#nested "show-username">
                <div id="kc-username" class="yoda-username">
                    <span id="kc-attempted-username">${auth.attemptedUsername}</span>
                    <a id="reset-login" href="${url.loginRestartFlowUrl}">${msg("restartLoginTooltip")}</a>
                </div>
            </#if>
        </header>

        <div id="kc-content">
          <div id="kc-content-wrapper">
            <#-- App-initiated actions should not see warning messages about the need to complete the action during login. -->
            <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                <div class="${properties.kcAlertClass!} yoda-alert--${message.type}" role="<#if message.type = 'error'>alert<#else>status</#if>">
                    <#if message.type = 'success'><span class="${properties.kcFeedbackSuccessIcon!}" aria-hidden="true"></span></#if>
                    <#if message.type = 'warning'><span class="${properties.kcFeedbackWarningIcon!}" aria-hidden="true"></span></#if>
                    <#if message.type = 'error'><span class="${properties.kcFeedbackErrorIcon!}" aria-hidden="true"></span></#if>
                    <#if message.type = 'info'><span class="${properties.kcFeedbackInfoIcon!}" aria-hidden="true"></span></#if>
                    <span class="${properties.kcAlertTitleClass!}">${kcSanitize(message.summary)?no_esc}</span>
                </div>
            </#if>

            <#nested "form">

            <#if auth?has_content && auth.showTryAnotherWayLink()>
                <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post">
                    <div class="${properties.kcFormGroupClass!}">
                        <input type="hidden" name="tryAnotherWay" value="on"/>
                        <a href="#" id="try-another-way"
                           onclick="document.forms['kc-select-try-another-way-form'].requestSubmit();return false;">${msg("doTryAnotherWay")}</a>
                    </div>
                </form>
            </#if>

            <#nested "socialProviders">

            <#if displayInfo>
                <div id="kc-info" class="${properties.kcSignUpClass!}">
                    <div id="kc-info-wrapper" class="${properties.kcInfoAreaWrapperClass!}">
                        <#nested "info">
                    </div>
                </div>
            </#if>
          </div>
        </div>

        <@loginFooter.content/>
      </div>
      <p class="yoda-foot">${msg("yodaFooter")}</p>
    </main>
</div>
</body>
</html>
</#macro>
