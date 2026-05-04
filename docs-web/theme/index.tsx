import { HomeLayout as BasicHomeLayout } from "@rspress/core/theme-original";
import { PackageManagerTabs } from "@rspress/core/theme-original";

function HomeLayout() {
  return (
    <BasicHomeLayout
      afterHeroActions={
        <div
          className="rp-doc"
          style={{ width: '100%', maxWidth: 450, margin: '-1rem 0' }}
        >
          <PackageManagerTabs command="install layercache" />
        </div>
      }
    />
  );
}

export { HomeLayout };

export * from "@rspress/core/theme-original";
