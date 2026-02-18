"use client";

import React, { useCallback, useEffect, useRef } from "react";

import { ActionKeyType } from "@/preferences";
import { ThRunningHeadFormat } from "@/preferences/models/enums";
import { ThFormatPref } from "@/preferences";

import { ThLayoutUI } from "@/preferences/models/enums";

import readerStyles from "./assets/styles/thorium-web.reader.app.module.css";
import readerHeaderStyles from "./assets/styles/thorium-web.reader.header.module.css";
import overflowMenuStyles from "./Actions/assets/styles/thorium-web.overflow.module.css";

import { ThActionEntry } from "@/core/Components/Actions/ThActionsBar";
import { ThHeader } from "@/core/Components/Reader/ThHeader";
import { StatefulBackLink } from "./StatefulBackLink";
import { StatefulReaderRunningHead } from "./StatefulReaderRunningHead";
import { ThInteractiveOverlay } from "../core/Components/Reader/ThInteractiveOverlay";
import { StatefulCollapsibleActionsBar } from "./Actions/StatefulCollapsibleActionsBar";

import { useI18n } from "@/i18n/useI18n";
import { usePlugins } from "./Plugins/PluginProvider";
import { usePreferences } from "@/preferences/hooks";
import { useActions } from "@/core/Components";
import { useFocusWithin } from "react-aria";

import { setHovering } from "@/lib/readerReducer";
import { useAppDispatch, useAppSelector } from "@/lib/hooks";

import classNames from "classnames";

// Ensure this import matches your directory structure
import { SpeechTrigger } from "./Actions/Triggers/SpeechTrigger";

export const StatefulReaderHeader = ({
  actionKeys,
  actionsOrder, 
  layout,
  runningHeadFormatPref
}: {
  actionKeys: ActionKeyType[];
  actionsOrder: ActionKeyType[];
  layout: ThLayoutUI;
  runningHeadFormatPref?: ThFormatPref<ThRunningHeadFormat>;
}) => {
  const headerRef = useRef<HTMLDivElement>(null);
  const { preferences } = usePreferences();
  const { t } = useI18n();
  const { actionsComponentsMap } = usePlugins();
  
  const actionsMap = useAppSelector(state => state.actions.keys);
  const overflowMap = useAppSelector(state => state.actions.overflow);
  const isScroll = useAppSelector(state => state.settings.scroll);
  const isImmersive = useAppSelector(state => state.reader.isImmersive);
  const isHovering = useAppSelector(state => state.reader.isHovering);
  const hasScrollAffordance = useAppSelector(state => state.reader.hasScrollAffordance);

  const actions = useActions({ ...actionsMap, ...overflowMap });
  const dispatch = useAppDispatch();

  const { focusWithinProps } = useFocusWithin({
    onFocusWithin() {
      dispatch(setHovering(true));
    },
    onBlurWithin() {      
      if (actions.everyOpenDocked()) {
        dispatch(setHovering(false));
      }
    }
  });

  const setHover = () => {
    if (!hasScrollAffordance && actions.everyOpenDocked()) {
      dispatch(setHovering(true));
    }
  };

  const removeHover = () => {
    if (!hasScrollAffordance && actions.everyOpenDocked()) {
      dispatch(setHovering(false));
    }
  };

  const listActionItems = useCallback(() => {
    const actionsItems: ThActionEntry<ActionKeyType>[] = [];

    // Force the addition of our new button
    actionsItems.push({
      Trigger: SpeechTrigger,
      key: "speech-tts" as any
    });

    if (actionsComponentsMap && Object.keys(actionsComponentsMap).length > 0) {
      actionKeys.forEach((key) => {      
        if (actionsComponentsMap[key]) {
          actionsItems.push({
            Trigger: actionsComponentsMap[key].Trigger,
            Target: actionsComponentsMap[key].Target,
            key: key
          });
        }
      });
    }
    
    return actionsItems;
  }, [actionKeys, actionsComponentsMap]);

  useEffect(() => {
    if (isImmersive) {
      const focusElement = document.activeElement;
      if (focusElement && headerRef.current?.contains(focusElement)) {
        (focusElement as HTMLElement).blur();
      }
    }
  }, [isImmersive]);

  // Prevent crashes by defining the key manually
  const safePrefs = {
    ...preferences.actions,
    keys: {
      ...preferences.actions.keys,
      "speech-tts": {
        visibility: "always",
        order: -1
      }
    },
    displayOrder: ["speech-tts", ...actionsOrder]
  };

  return (
    <>
    <ThInteractiveOverlay 
      className={ classNames(readerStyles.barOverlay, readerStyles.headerOverlay) }
      isActive={ layout === ThLayoutUI.layered && isImmersive && !isHovering }
      onMouseEnter={ setHover }
      onMouseLeave={ removeHover }
    />

    <ThHeader 
      ref={ headerRef }
      className={ classNames(readerStyles.topBar, readerHeaderStyles.header) } 
      aria-label={ t("reader.app.header.label") } 
      onMouseEnter={ setHover } 
      onMouseLeave={ removeHover }
      { ...focusWithinProps }
    >
      { preferences.theming.header?.backLink && <StatefulBackLink className={ readerHeaderStyles.backlinkWrapper } /> }
      
      <StatefulReaderRunningHead formatPref={ runningHeadFormatPref } />
      
      <StatefulCollapsibleActionsBar 
        id="reader-header-overflowMenu" 
        items={ listActionItems() }
        prefs={ safePrefs as any }
        className={ readerHeaderStyles.actionsWrapper } 
        aria-label={ t("reader.app.header.actions") } 
        overflowMenuClassName={ 
          (!isScroll || preferences.affordances.scroll.hintInImmersive) 
            ? overflowMenuStyles.hint 
            : undefined 
        }
      />
    </ThHeader>
    </>
  );
};
