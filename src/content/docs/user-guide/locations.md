---
title: Locations
description: Manage locations extracted from your script and maintain visual consistency
section: User Guide
order: 4
---

The **Locations** tab shows all settings and environments identified during script analysis. OpenStory extracts location details from your screenplay and generates reference images for visual consistency.

## Location Grid

Locations appear as a grid of cards, each showing:

- **Reference image** — A generated reference image of the location
- **Name** — The location's name as described in the script

Click any card to view the full location detail page.

## Location Detail Page

The detail page provides comprehensive information about a location:

### Reference Image

A 16:9 reference image generated from the script's location description. This image anchors the visual style for all scenes set in this location.

### Location Properties

All properties are automatically extracted from your script:

| Property | Description |
|----------|-------------|
| **Name** | Location name |
| **Type** | Interior, Exterior, or Interior/Exterior |
| **Time of Day** | Default lighting context |
| **Description** | Detailed setting description |
| **Architectural Style** | Building and structural aesthetic |
| **Key Features** | Notable visual elements |
| **Color Palette** | Dominant colors for the setting |
| **Lighting Setup** | Default lighting configuration |
| **Ambiance** | Overall mood and atmosphere |
| **First Appears** | Scene number and line where the location first appears, with quoted text |
| **Consistency Tag** | Internal tag for maintaining visual consistency (shown as monospace code badge) |

### Frame Count

The detail page shows how many frames use this location (e.g., "Used in 5 frames").

## Updating Location References

You can replace a location's auto-generated reference with one from your Location Library:

1. Click **Update Reference** on the location detail page
2. A **Location Picker** dialog opens showing library locations
3. Select a library location
4. A **confirmation dialog** shows:
   - The location name and library location name
   - How many frames will be affected
5. Confirm to update

This regenerates the location's reference image and updates all frames set in this location.

## Real-Time Updates

Location reference regeneration uses the same real-time event system as characters. The UI subscribes to `generation.location-sheet:progress` events and updates automatically.
