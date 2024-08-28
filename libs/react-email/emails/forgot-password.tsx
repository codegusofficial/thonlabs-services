import { Link, Text } from '@react-email/components';
import * as React from 'react';
import EmailBaseTemplate from './email-base-template';
import { buttonVariants } from '@/ui/components/button';
import { textVariants } from '@/ui/components/text';

export function ForgotPassword() {
  const href = `<%= authURL %>/auth/reset-password/<%= token %>?r=<%= appURL %>`;

  return (
    <EmailBaseTemplate title="Reset Your Account Password">
      <Text className={textVariants({ variant: 'paragraphEmail' })}>
        Hey{' '}
        {
          '<% if (userFirstName) { %> <%= userFirstName %><% } else { %>there<% } %>'
        }
        ! 👋
      </Text>

      <Text
        className={textVariants({
          variant: 'paragraphEmail',
          className: 'mb-3',
        })}
      >
        We received a recent request to reset the password for your account. To
        proceed with the password reset, kindly click on the button provided
        below.
      </Text>

      <Link
        className={buttonVariants({
          variant: 'default',
        })}
        href={href}
      >
        Reset Password
      </Link>

      <Text
        className={textVariants({
          variant: 'paragraphEmail',
          className: 'mt-4 mb-0',
        })}
      >
        In case of the button not works, you can reset the password through the
        link:
      </Text>
      <Link href={href} className="mt-0 text-blue-500 text-sm">
        {href}
      </Link>

      <Text
        className={textVariants({
          variant: 'paragraphEmail',
          className: 'mt-6 mb-5',
        })}
      >
        If you didn't initiate this reset password request, please disregard
        this message or contact our security team on{' '}
        <Link href={href} className="mt-0 mb-3 text-blue-500">
          security@thonlabs.io
        </Link>
        .
      </Text>
    </EmailBaseTemplate>
  );
}

export default ForgotPassword;
