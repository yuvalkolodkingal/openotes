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

import { Flex, Link, Text } from "@theme-ui/components";
import Field from "../components/field";
import Dialog from "../components/dialog";
import { useState } from "react";
import { ErrorText } from "../components/error-text";
import { BaseDialogProps, DialogManager } from "../common/dialog-manager";
import { strings } from "@notesnook/intl";
import { getDeviceInfo } from "../utils/platform";

const PLACEHOLDERS = {
  title: strings.issueTitlePlaceholder(),
  body: strings.issuePlaceholder()
};

/**
 * Openotes has no bug-reporting backend of its own (upstream posted reports
 * to issues.streetwriters.co through an account). Reports are filed straight
 * on this fork's issue tracker instead: the dialog only composes the report
 * and opens a prefilled GitHub issue in the browser.
 */
const ISSUES_URL = "https://github.com/yuvalkolodkingal/notesnook/issues";

type IssueDialogProps = BaseDialogProps<boolean>;
export const IssueDialog = DialogManager.register(function IssueDialog(
  props: IssueDialogProps
) {
  const [error, setError] = useState<string>();

  return (
    <Dialog
      isOpen={true}
      title={strings.reportAnIssue()}
      onClose={() => props.onClose(false)}
      positiveButton={{
        text: strings.submit(),
        form: "issueForm"
      }}
      negativeButton={{
        text: strings.cancel(),
        onClick: () => props.onClose(false)
      }}
    >
      <Flex
        id="issueForm"
        as="form"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            setError(undefined);

            const formData = new FormData(e.target as HTMLFormElement);
            const requestData = Object.fromEntries(
              formData.entries() as IterableIterator<[string, string]>
            );

            if (!requestData.title.trim() || !requestData.body.trim()) return;

            const url = new URL(`${ISSUES_URL}/new`);
            url.searchParams.set("title", requestData.title);
            url.searchParams.set("body", BODY_TEMPLATE(requestData.body));

            const opened = window.open(url.href, "_blank");
            if (!opened)
              throw new Error(
                `Could not open the issue tracker. Please file the report at ${ISSUES_URL} manually.`
              );

            props.onClose(true);
          } catch (e) {
            if (e instanceof Error) setError(e.message);
          }
        }}
        sx={{ flexDirection: "column" }}
      >
        <Field
          required
          label={strings.title()}
          id="title"
          name="title"
          placeholder={PLACEHOLDERS.title}
          autoFocus
        />
        <Field
          as="textarea"
          required
          variant="forms.input"
          label={strings.description()}
          id="body"
          name="body"
          placeholder={PLACEHOLDERS.body}
          sx={{ mt: 1 }}
          styles={{
            input: {
              minHeight: 150
            }
          }}
        />
        <Text
          variant="error"
          bg={"var(--background-error)"}
          mt={1}
          p={1}
          sx={{ borderRadius: "default" }}
        >
          {strings.issueNotice[0]()}{" "}
          <Link href={ISSUES_URL} title={ISSUES_URL} target="_blank">
            {ISSUES_URL.replace("https://", "")}
          </Link>
        </Text>
        <Text variant="subBody" mt={1}>
          {getDeviceInfo()
            .split("\n")
            .map((t) => (
              <>
                {t}
                <br />
              </>
            ))}
        </Text>
        <ErrorText error={error} />
      </Flex>
    </Dialog>
  );
});

const BODY_TEMPLATE = (body: string) => {
  const info = `**Device information:**\n${getDeviceInfo()}`;
  if (!body) return info;
  return `${body}\n\n${info}`;
};
