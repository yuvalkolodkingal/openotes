/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { Button, Flex } from "@theme-ui/components";
import { ThemeUICSSObject } from "@theme-ui/core";
import { ThemeUIStyleObject } from "@theme-ui/css";
import type { ReactNode } from "react";
import type { MenuItem } from "@notesnook/ui";
import { useMenuTrigger } from "../../hooks/use-menu";
import { ChevronDown } from "../icons";

type DropdownButtonOption = {
  title: () => ReactNode;
  onClick?: () => void;
};

type DropdownButtonProps = {
  options?: DropdownButtonOption[];
  title?: string;
  sx?: ThemeUIStyleObject;
  buttonStyle?: ThemeUICSSObject;
  chevronStyle?: ThemeUICSSObject;
};

export default function DropdownButton(props: DropdownButtonProps) {
  const { openMenu } = useMenuTrigger();
  const { options, title, sx, buttonStyle, chevronStyle } = props;

  if (!options || !options.length) return null;
  return (
    <Flex sx={sx}>
      <Button
        sx={{
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
          ...buttonStyle
        }}
        onClick={options[0].onClick}
      >
        {options[0].title()}
      </Button>
      {options.length > 1 && (
        <Button
          px={1}
          sx={{
            borderBottomLeftRadius: 0,
            borderTopLeftRadius: 0,
            ...chevronStyle
          }}
          onClick={() =>
            // These options carry a callable `title`, which predates the
            // current `MenuItem` shape (where `title` is a plain string). The
            // component has no call sites left in the repo to infer the real
            // shape from, so the mismatch is cast away at this one boundary
            // instead of redesigning either this component or `MenuItem`.
            openMenu(options.slice(1) as unknown as MenuItem[], { title })
          }
        >
          <ChevronDown color="white" size={18} />
        </Button>
      )}
    </Flex>
  );
}
