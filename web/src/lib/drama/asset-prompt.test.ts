import assert from "node:assert/strict";
import { test } from "node:test";

import { CHARACTER_VARIABLES, renderAssetPrompt, unknownAssetVariables } from "./asset-prompt";

test("asset prompt preview renders every variable and collapses empty sentences", () => {
    const text = renderAssetPrompt("{{项目画风}}。角色：{{角色名称}}。{{角色设定}}。{{画面规则}}", { 项目画风: "国风动画", 角色名称: "林逸", 角色设定: "黑发少年", 画面规则: "" });
    assert.equal(text, "国风动画。角色：林逸。黑发少年。");
    assert.ok(!text.includes("{{"));
});

test("asset prompt preview reports unknown variables once", () => {
    assert.deepEqual(unknownAssetVariables("{{角色名称}} {{外号}} {{外号}}", CHARACTER_VARIABLES), ["{{外号}}"]);
    assert.deepEqual(unknownAssetVariables("{{角色名称}}{{画面规则}}", CHARACTER_VARIABLES), []);
});
