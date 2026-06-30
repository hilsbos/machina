/**
 * Unit tests for positionDropdown() logic in dashboard-ui.html.
 *
 * Tests the positioning algorithm in isolation by extracting the core logic
 * and mocking DOM measurements. No browser or JSDOM required.
 *
 * Run with: npx tsx dashboard-dropdown-position.test.ts
 */

// ---- Test helpers ----

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
  }
}

// ---- Pure-logic mirror of positionDropdown() ----

interface PositionResult {
  top: number;
  maxHeight: string;
}

/**
 * Pure-logic equivalent of positionDropdown() from dashboard-ui.html.
 * Returns computed top and maxHeight instead of mutating DOM styles.
 */
function computeDropdownPosition(
  anchorBottom: number,
  anchorTop: number,
  dropdownHeight: number,
  viewportHeight: number,
  callerMaxHeight: string | null
): PositionResult {
  var viewportPadding = 8;
  var gap = 2;
  var spaceBelow = viewportHeight - anchorBottom - viewportPadding - gap;
  var spaceAbove = anchorTop - viewportPadding - gap;

  if (spaceBelow >= dropdownHeight) {
    // Fits below — open downward
    return {
      top: anchorBottom + gap,
      maxHeight: callerMaxHeight || 'none',
    };
  } else if (spaceAbove >= dropdownHeight) {
    // Fits above — open upward
    return {
      top: anchorTop - dropdownHeight - gap,
      maxHeight: callerMaxHeight || 'none',
    };
  } else if (spaceBelow >= spaceAbove) {
    // More space below — constrain height
    var maxBelow = spaceBelow;
    if (callerMaxHeight && callerMaxHeight !== 'none') {
      maxBelow = Math.min(parseFloat(callerMaxHeight), maxBelow);
    }
    return {
      top: anchorBottom + gap,
      maxHeight: Math.max(0, maxBelow) + 'px',
    };
  } else {
    // More space above — constrain height
    var maxAbove = spaceAbove;
    if (callerMaxHeight && callerMaxHeight !== 'none') {
      maxAbove = Math.min(parseFloat(callerMaxHeight), maxAbove);
    }
    return {
      top: viewportPadding,
      maxHeight: Math.max(0, maxAbove) + 'px',
    };
  }
}

// ---- Tests ----

console.log('\npositionDropdown logic tests\n');

// Test 1: Dropdown fits below — should open downward with no constraint
console.log('  Fits below:');
{
  const result = computeDropdownPosition(100, 80, 200, 800, null);
  assertEqual(result.top, 102, 'top = anchorBottom + 2px gap');
  assertEqual(result.maxHeight, 'none', 'maxHeight is none when fits fully');
}

// Test 2: Dropdown fits above but not below — should open upward
console.log('  Fits above (not below):');
{
  // anchor near bottom of viewport
  const result = computeDropdownPosition(750, 730, 200, 800, null);
  // spaceBelow = 800 - 750 - 8 - 2 = 40 (< 200)
  // spaceAbove = 730 - 8 - 2 = 720 (>= 200)
  assertEqual(result.top, 730 - 200 - 2, 'top = anchorTop - height - gap');
  assertEqual(result.maxHeight, 'none', 'maxHeight is none when fits fully');
}

// Test 3: Neither fits — more space below, constrain height
console.log('  Constrained below:');
{
  // anchor in middle, dropdown very tall
  const result = computeDropdownPosition(400, 380, 500, 600, null);
  // spaceBelow = 600 - 400 - 8 - 2 = 190 (< 500)
  // spaceAbove = 380 - 8 - 2 = 370 (< 500, but > 190)
  // More space above → should go above
  assertEqual(result.top, 8, 'top = viewportPadding when constrained above');
  assertEqual(result.maxHeight, '370px', 'maxHeight = spaceAbove when constrained');
}

// Test 4: Neither fits — more space below
console.log('  Constrained below (more space below):');
{
  const result = computeDropdownPosition(200, 180, 700, 800, null);
  // spaceBelow = 800 - 200 - 8 - 2 = 590 (< 700)
  // spaceAbove = 180 - 8 - 2 = 170 (< 700, < 590)
  // More space below
  assertEqual(result.top, 202, 'top = anchorBottom + gap');
  assertEqual(result.maxHeight, '590px', 'maxHeight = spaceBelow');
}

// Test 5: Viewport padding respected — bottom edge
console.log('  Viewport padding:');
{
  const result = computeDropdownPosition(200, 180, 700, 800, null);
  // dropdown bottom = top + maxHeight = 202 + 590 = 792
  // viewport edge = 800, so padding = 800 - 792 = 8 ✓
  const bottomEdge = result.top + parseFloat(result.maxHeight);
  assertEqual(bottomEdge, 792, 'bottom edge = viewport - 8px padding');
}

// Test 6: Caller-set maxHeight is preserved when dropdown fits
console.log('  Caller maxHeight preserved (fits):');
{
  const result = computeDropdownPosition(100, 80, 200, 800, '300px');
  assertEqual(result.maxHeight, '300px', 'callerMaxHeight preserved when fits');
}

// Test 7: Caller-set maxHeight used as upper bound when constrained
console.log('  Caller maxHeight as upper bound (constrained):');
{
  const result = computeDropdownPosition(200, 180, 700, 800, '300px');
  // spaceBelow = 590, callerMaxHeight = 300 → min(300, 590) = 300
  assertEqual(result.maxHeight, '300px', 'callerMaxHeight caps constrained height');
}

// Test 8: Caller maxHeight exceeded by viewport — viewport wins
console.log('  Viewport constraint wins over caller maxHeight:');
{
  const result = computeDropdownPosition(200, 180, 700, 300, '500px');
  // spaceBelow = 300 - 200 - 8 - 2 = 90
  // spaceAbove = 180 - 8 - 2 = 170
  // More space above (170 > 90)
  // maxAbove = min(500, 170) = 170
  assertEqual(result.maxHeight, '170px', 'viewport constraint overrides larger callerMaxHeight');
}

// Test 9: Filter dropdown regression test — 300px cap must not be clobbered
console.log('  Filter dropdown 300px cap not clobbered:');
{
  // Simulate: generous viewport, filter dropdown sets 300px cap
  const result = computeDropdownPosition(100, 80, 250, 800, '300px');
  // spaceBelow = 800 - 100 - 8 - 2 = 690 (>= 250, fits!)
  assertEqual(result.maxHeight, '300px', 'filter dropdown 300px cap preserved');
}

// ---- Summary ----

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
