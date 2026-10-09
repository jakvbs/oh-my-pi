import rootLicense from "./license-assets/LICENSE.txt" with { type: "text" };
import thirdPartyNotices from "./license-assets/THIRD-PARTY-NOTICES.txt" with { type: "text" };

export function formatLicenseOutput(): string {
	return `OMP License and Third-Party Notices\n\n${rootLicense.trimEnd()}\n\n${thirdPartyNotices.trimEnd()}\n`;
}
