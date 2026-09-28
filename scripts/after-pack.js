/**
 * electron-builder afterPack hook.
 *
 * Windows builds made on Linux normally need Wine to run rcedit for the executable's icon and
 * version metadata. This hook does the same with the pure-JavaScript `resedit` library, so
 * `signAndEditExecutable` can stay disabled and no Wine installation is required.
 */
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const ResEdit = require('resedit');
  const { productFilename, version, productName } = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico');

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  if (fs.existsSync(iconPath)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      1033,
      iconFile.icons.map((item) => item.data)
    );
  }

  const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);
  const versionInfos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = versionInfos[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const lang = { lang: 1033, codepage: 1200 };
  vi.setFileVersion(major, minor, patch, 0, 1033);
  vi.setProductVersion(major, minor, patch, 0, 1033);
  vi.setStringValues(lang, {
    ProductName: productName,
    FileDescription: productName,
    CompanyName: productName,
    LegalCopyright: `Copyright (c) ${new Date().getFullYear()} ${productName} contributors`,
    OriginalFilename: `${productFilename}.exe`,
    InternalName: productFilename,
    FileVersion: version,
    ProductVersion: version
  });
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • afterPack: set icon and version ${version} on ${path.basename(exePath)}`);
};
